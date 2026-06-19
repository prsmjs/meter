/**
 * In-memory meter driver. Mirrors the postgres driver's aggregation semantics
 * exactly, so the test suite can exercise meter behavior without infrastructure.
 * Not durable - state lives for the lifetime of the process.
 *
 * @returns {object} a driver for `createMeter({ driver })`
 */
export function memoryDriver() {
  const events = []
  const seenKeys = new Set()
  const aggregates = new Map()
  const members = new Map()
  const subjectActivity = new Map()

  // NUL separator so the composite map key stays injective even when a subject,
  // metric, or bucket contains spaces or other delimiters
  const SEP = "\u0000"
  const key = (subject, metric, bucket) => `${subject}${SEP}${metric}${SEP}${bucket}`

  function applyAggregate(subject, metric, bucket, aggregate, quantity, member, at) {
    const k = key(subject, metric, bucket)
    let row = aggregates.get(k)
    if (!row) {
      row = { subject, metric, bucket, aggregate: 0, lastAt: new Date(0), count: 0 }
      aggregates.set(k, row)
    }
    row.count++
    switch (aggregate) {
      case "sum": row.aggregate += quantity; break
      case "max": row.aggregate = Math.max(row.aggregate, quantity); break
      case "last":
        if (at.getTime() >= row.lastAt.getTime()) {
          row.aggregate = quantity
          row.lastAt = at
        }
        break
      case "unique": {
        let entry = members.get(k)
        if (!entry) { entry = { subject, metric, set: new Set() }; members.set(k, entry) }
        entry.set.add(member)
        row.aggregate = entry.set.size
        break
      }
    }
    return row.aggregate
  }

  return {
    async setup() {},

    async record({ subject, metric, aggregate, quantity, member, idempotencyKey, at, bucket }) {
      const k = key(subject, metric, bucket)
      if (idempotencyKey != null && seenKeys.has(idempotencyKey)) {
        return { quantity: aggregates.get(k)?.aggregate ?? 0 }
      }
      if (idempotencyKey != null) seenKeys.add(idempotencyKey)
      events.push({ subject, metric, quantity, member, at, bucket })
      subjectActivity.set(subject, new Date())
      return { quantity: applyAggregate(subject, metric, bucket, aggregate, quantity, member, at) }
    },

    async subjects({ limit }) {
      return [...subjectActivity.entries()]
        .sort((a, b) => b[1].getTime() - a[1].getTime() || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([subject, lastActivityAt]) => ({ subject, lastActivityAt }))
    },

    async readBucket({ subject, metric, bucket }) {
      return aggregates.get(key(subject, metric, bucket))?.aggregate ?? 0
    },

    async readWindow({ subject, metric, aggregate, start, end, endInclusive }) {
      const lo = start.getTime()
      const hi = end.getTime()
      const rows = events.filter((e) => {
        const t = e.at.getTime()
        return e.subject === subject && e.metric === metric && t >= lo && (endInclusive ? t <= hi : t < hi)
      })
      switch (aggregate) {
        case "sum": return rows.reduce((t, e) => t + e.quantity, 0)
        case "max": return rows.reduce((m, e) => Math.max(m, e.quantity), rows.length ? -Infinity : 0)
        case "last": {
          let latest = null
          for (const e of rows) if (!latest || e.at.getTime() >= latest.at.getTime()) latest = e
          return latest ? latest.quantity : 0
        }
        case "unique": return new Set(rows.map((e) => e.member)).size
        default: return 0
      }
    },

    async summary({ subject, bucket }) {
      const out = new Map()
      for (const row of aggregates.values()) {
        if (row.subject === subject && row.bucket === bucket) out.set(row.metric, row.aggregate)
      }
      return out
    },

    async rebuild({ entries, subject }) {
      const aggregateOf = new Map(entries.map((e) => [e.metric, e.aggregate]))
      const inScope = (s, metric) => (subject == null || s === subject) && aggregateOf.has(metric)

      for (const [k, row] of aggregates) if (inScope(row.subject, row.metric)) aggregates.delete(k)
      for (const [k, entry] of members) if (inScope(entry.subject, entry.metric)) members.delete(k)

      for (const e of events) {
        if (!inScope(e.subject, e.metric)) continue
        applyAggregate(e.subject, e.metric, e.bucket, aggregateOf.get(e.metric), e.quantity, e.member, e.at)
      }
    },

    async close() {},
  }
}
