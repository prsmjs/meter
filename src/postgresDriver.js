/**
 * @typedef {Object} PostgresDriverOptions
 * @property {import("pg").Pool} pool - a `pg` Pool
 * @property {string} [prefix] - table name prefix (default `"meter"`), for keeping several meters in one database
 */

/**
 * Durable postgres meter driver. The event table is the append-only source of
 * truth; the aggregate table is a materialized per-(subject, metric, bucket)
 * rollup maintained atomically on each record so quota checks are a single-row
 * read. Distinct counting for `unique` metrics is backed by a members table.
 *
 * @param {PostgresDriverOptions} options
 * @returns {object} a driver for `createMeter({ driver })`
 */
export function postgresDriver(options = {}) {
  const { pool, prefix = "meter" } = options
  if (!pool) throw new Error("postgresDriver requires a `pool`")

  const events = `${prefix}_events`
  const aggs = `${prefix}_aggregates`
  const uniqueMembers = `${prefix}_unique_members`

  const windowAggregate = {
    sum: `coalesce(sum(quantity), 0)`,
    max: `coalesce(max(quantity), 0)`,
    unique: `count(distinct member)`,
  }

  const conflictSet = {
    sum: `aggregate = ${aggs}.aggregate + excluded.aggregate, event_count = ${aggs}.event_count + 1, last_at = greatest(${aggs}.last_at, excluded.last_at), updated_at = now()`,
    max: `aggregate = greatest(${aggs}.aggregate, excluded.aggregate), event_count = ${aggs}.event_count + 1, last_at = greatest(${aggs}.last_at, excluded.last_at), updated_at = now()`,
    last: `aggregate = case when excluded.last_at >= ${aggs}.last_at then excluded.aggregate else ${aggs}.aggregate end, event_count = ${aggs}.event_count + 1, last_at = greatest(${aggs}.last_at, excluded.last_at), updated_at = now()`,
  }

  return {
    async setup() {
      await pool.query(`
        create table if not exists ${events} (
          id bigserial primary key,
          subject text not null,
          metric text not null,
          quantity double precision,
          member text,
          at timestamptz not null default now(),
          idempotency_key text,
          bucket text not null
        );
        create index if not exists ${events}_lookup on ${events} (subject, metric, at);
        create unique index if not exists ${events}_idem on ${events} (idempotency_key) where idempotency_key is not null;

        create table if not exists ${aggs} (
          subject text not null,
          metric text not null,
          bucket text not null,
          aggregate double precision not null default 0,
          event_count bigint not null default 0,
          last_at timestamptz not null default to_timestamp(0),
          updated_at timestamptz not null default now(),
          primary key (subject, metric, bucket)
        );

        create table if not exists ${uniqueMembers} (
          subject text not null,
          metric text not null,
          bucket text not null,
          member text not null,
          primary key (subject, metric, bucket, member)
        );
      `)
    },

    async record({ subject, metric, aggregate, quantity, member, idempotencyKey, at, bucket }) {
      const client = await pool.connect()
      try {
        await client.query("begin")

        const insert = await client.query(
          `insert into ${events} (subject, metric, quantity, member, at, idempotency_key, bucket)
           values ($1, $2, $3, $4, $5, $6, $7)
           ${idempotencyKey != null ? "on conflict (idempotency_key) where idempotency_key is not null do nothing" : ""}
           returning id`,
          [subject, metric, quantity, member, at, idempotencyKey, bucket],
        )

        if (insert.rowCount === 0) {
          const current = await client.query(
            `select aggregate from ${aggs} where subject = $1 and metric = $2 and bucket = $3`,
            [subject, metric, bucket],
          )
          await client.query("commit")
          return { quantity: current.rowCount ? Number(current.rows[0].aggregate) : 0 }
        }

        let result
        if (aggregate === "unique") {
          const m = await client.query(
            `insert into ${uniqueMembers} (subject, metric, bucket, member)
             values ($1, $2, $3, $4) on conflict do nothing returning member`,
            [subject, metric, bucket, member],
          )
          const delta = m.rowCount > 0 ? 1 : 0
          result = await client.query(
            `insert into ${aggs} (subject, metric, bucket, aggregate, event_count, last_at, updated_at)
             values ($1, $2, $3, $4, 1, $5, now())
             on conflict (subject, metric, bucket) do update
             set aggregate = ${aggs}.aggregate + $4, event_count = ${aggs}.event_count + 1, updated_at = now()
             returning aggregate`,
            [subject, metric, bucket, delta, at],
          )
        } else {
          result = await client.query(
            `insert into ${aggs} (subject, metric, bucket, aggregate, event_count, last_at, updated_at)
             values ($1, $2, $3, $4, 1, $5, now())
             on conflict (subject, metric, bucket) do update set ${conflictSet[aggregate]}
             returning aggregate`,
            [subject, metric, bucket, quantity, at],
          )
        }

        await client.query("commit")
        return { quantity: Number(result.rows[0].aggregate) }
      } catch (err) {
        await client.query("rollback").catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async readBucket({ subject, metric, bucket }) {
      const r = await pool.query(
        `select aggregate from ${aggs} where subject = $1 and metric = $2 and bucket = $3`,
        [subject, metric, bucket],
      )
      return r.rowCount ? Number(r.rows[0].aggregate) : 0
    },

    async readWindow({ subject, metric, aggregate, start, end, endInclusive }) {
      const where = `where subject = $1 and metric = $2 and at >= $3 and at ${endInclusive ? "<=" : "<"} $4`
      if (aggregate === "last") {
        const r = await pool.query(
          `select quantity from ${events} ${where} order by at desc, id desc limit 1`,
          [subject, metric, start, end],
        )
        return r.rowCount ? Number(r.rows[0].quantity) : 0
      }
      const r = await pool.query(
        `select ${windowAggregate[aggregate]} as value from ${events} ${where}`,
        [subject, metric, start, end],
      )
      return Number(r.rows[0].value)
    },

    async summary({ subject, bucket }) {
      const r = await pool.query(
        `select metric, aggregate from ${aggs} where subject = $1 and bucket = $2`,
        [subject, bucket],
      )
      const out = new Map()
      for (const row of r.rows) out.set(row.metric, Number(row.aggregate))
      return out
    },

    async rebuild({ entries, subject }) {
      const expr = {
        sum: `coalesce(sum(quantity), 0)`,
        max: `coalesce(max(quantity), 0)`,
        last: `(array_agg(quantity order by at desc, id desc))[1]`,
        unique: `count(distinct member)`,
      }
      const byType = { sum: [], max: [], last: [], unique: [] }
      for (const e of entries) byType[e.aggregate].push(e.metric)
      const allMetrics = entries.map((e) => e.metric)
      if (allMetrics.length === 0) return

      const scoped = subject != null
      const scopeClause = scoped ? " and subject = $2" : ""

      const client = await pool.connect()
      try {
        await client.query("begin")
        await client.query(
          `delete from ${aggs} where metric = any($1)${scopeClause}`,
          scoped ? [allMetrics, subject] : [allMetrics],
        )

        if (byType.unique.length) {
          await client.query(
            `delete from ${uniqueMembers} where metric = any($1)${scopeClause}`,
            scoped ? [byType.unique, subject] : [byType.unique],
          )
          await client.query(
            `insert into ${uniqueMembers} (subject, metric, bucket, member)
             select distinct subject, metric, bucket, member from ${events}
             where metric = any($1) and member is not null${scopeClause}`,
            scoped ? [byType.unique, subject] : [byType.unique],
          )
        }

        for (const [type, metrics] of Object.entries(byType)) {
          if (!metrics.length) continue
          await client.query(
            `insert into ${aggs} (subject, metric, bucket, aggregate, event_count, last_at, updated_at)
             select subject, metric, bucket, ${expr[type]}, count(*), max(at), now()
             from ${events}
             where metric = any($1)${scopeClause}
             group by subject, metric, bucket`,
            scoped ? [metrics, subject] : [metrics],
          )
        }

        await client.query("commit")
      } catch (err) {
        await client.query("rollback").catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async close() {},
  }
}
