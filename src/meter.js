import { resolveWindow, bucketKey, CALENDAR_UNITS } from "./period.js"

/**
 * @typedef {"sum"|"max"|"last"|"unique"} Aggregate
 * How a metric's events combine within a period.
 *
 * - `"sum"` - add quantities together (tokens, API calls, bytes transferred).
 * - `"max"` - keep the high-water mark (peak concurrent seats).
 * - `"last"` - keep the most recent value, a gauge (current GB stored).
 * - `"unique"` - count distinct identifiers (monthly active users). Events for a
 *   unique metric carry a `value` (the identifier), not a `quantity`.
 */

/**
 * @typedef {Object} MetricDef
 * @property {string} unit - descriptive label that travels onto usage results and invoices (`"tokens"`, `"GB"`); never converted
 * @property {Aggregate} aggregate - how quantities combine within a period
 */

/**
 * @typedef {Object} MeterOptions
 * @property {Object} driver - storage backend: `postgresDriver({ pool })` for production, `memoryDriver()` for tests
 * @property {Record<string, MetricDef>} metrics - the metric catalog, declared once; recording an undeclared metric throws
 * @property {import("./period.js").CalendarPeriod} [period] - billing granularity that gets materialized for fast reads (default `"month"`)
 * @property {{ startSpan: Function }} [tracer] - optional `@prsm/trace` tracer; record/usage/check are wrapped in spans when present
 */

/**
 * @typedef {Object} RecordInput
 * @property {string} subject - who the usage belongs to (account, tenant, user id)
 * @property {string} metric - a key from the metric catalog
 * @property {number} [quantity] - amount to record, for `sum`/`max`/`last` metrics
 * @property {string|number} [value] - distinct identifier to count, for `unique` metrics
 * @property {string} [idempotencyKey] - dedupe key; a repeat with the same key is recorded once (double-counting is overbilling)
 * @property {Date} [at] - event timestamp (default now); use for backfilling
 */

/**
 * @typedef {Object} UsageQuery
 * @property {string} subject - who the usage belongs to (account, tenant, or user id), the same identifier passed to `record`
 * @property {string} metric - a key from the metric catalog; querying an undeclared metric throws
 * @property {import("./period.js").Period} [period] - calendar keyword or duration to scope the query (default: the meter's configured granularity, served from the materialized aggregate fast path)
 * @property {import("./period.js").Range} [range] - explicit `{ start, end }` window for a fixed cycle; when present it takes precedence over `period` and reads from the event log
 */

/**
 * @typedef {Object} Usage
 * @property {string} metric - the metric this entry reports on
 * @property {number} quantity - the aggregated value over the window, combined according to the metric's `aggregate`
 * @property {string} unit - the metric's descriptive unit label, carried through from its catalog definition
 * @property {Aggregate} aggregate - how the quantity was combined (`sum`, `max`, `last`, or `unique`)
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} allowed - whether current usage is strictly below `limit` (the check is exclusive, so reaching exactly the limit is not allowed)
 * @property {number} used - current usage over the window
 * @property {number} remaining - headroom left before the limit, computed as `max(0, limit - used)`
 * @property {number} limit - the quota the usage was compared against, echoed back from the query
 * @property {string} unit - the metric's unit label, for rendering the result
 * @property {string} metric - the metric that was checked
 */

const AGGREGATES = new Set(["sum", "max", "last", "unique"])

function validateCatalog(metrics) {
  if (!metrics || typeof metrics !== "object" || Object.keys(metrics).length === 0) {
    throw new Error("createMeter requires a non-empty `metrics` catalog")
  }
  for (const [name, def] of Object.entries(metrics)) {
    if (!def || typeof def.unit !== "string" || !def.unit) {
      throw new Error(`metric "${name}" needs a string \`unit\``)
    }
    if (!AGGREGATES.has(def.aggregate)) {
      throw new Error(`metric "${name}" has invalid aggregate "${def.aggregate}"; use one of ${[...AGGREGATES].join("|")}`)
    }
  }
}

async function traced(tracer, name, attrs, fn) {
  const span = tracer?.startSpan(name, attrs)
  try {
    return await fn()
  } catch (err) {
    span?.setError(err)
    throw err
  } finally {
    span?.end()
  }
}

/**
 * Create a usage meter: a durable ledger of how much each subject consumes,
 * for billing and quota enforcement.
 *
 * @param {MeterOptions} options
 */
export function createMeter(options = {}) {
  const { driver, metrics, period = "month", tracer = null } = options

  if (!driver) throw new Error("createMeter requires a `driver` (postgresDriver or memoryDriver)")
  if (!CALENDAR_UNITS.includes(period)) {
    throw new Error(`meter \`period\` must be a calendar granularity (${CALENDAR_UNITS.join("|")}), got ${JSON.stringify(period)}`)
  }
  validateCatalog(metrics)

  const catalog = { ...metrics }

  function requireMetric(metric) {
    const def = catalog[metric]
    if (!def) {
      throw new Error(`unknown metric "${metric}". declared metrics: ${Object.keys(catalog).join(", ") || "(none)"}`)
    }
    return def
  }

  return {
    /** Create the backing tables if they do not exist. Idempotent. */
    setup() {
      return driver.setup()
    },

    /**
     * Record a usage event. Returns the metric's new aggregate value for the
     * current period. A repeat with the same `idempotencyKey` is a no-op and
     * returns the unchanged aggregate.
     * @param {RecordInput} input
     * @returns {Promise<{ quantity: number, unit: string }>}
     */
    async record(input = {}) {
      const { subject, metric, quantity, value, idempotencyKey = null, at } = input
      if (!subject) throw new Error("record requires a `subject`")
      const def = requireMetric(metric)
      const when = at ?? new Date()

      let q = null
      let member = null
      if (def.aggregate === "unique") {
        if (value == null) {
          throw new Error(`metric "${metric}" is a unique metric; pass { value } (the identifier to count distinct), not { quantity }`)
        }
        member = String(value)
      } else {
        if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
          throw new Error(`metric "${metric}" requires a finite numeric { quantity }`)
        }
        q = quantity
      }

      const bucket = bucketKey(period, when)
      const res = await traced(tracer, "meter.record", { "meter.subject": subject, "meter.metric": metric }, () =>
        driver.record({ subject, metric, aggregate: def.aggregate, quantity: q, member, idempotencyKey, at: when, bucket }),
      )
      return { quantity: res.quantity, unit: def.unit }
    },

    /**
     * Read aggregated usage over a window. With no `period` or `range`, returns
     * the current billing period from the materialized aggregate (fast path).
     * @param {UsageQuery} query
     * @returns {Promise<Usage>}
     */
    async usage(query = {}) {
      const { subject, metric, period: p, range } = query
      if (!subject) throw new Error("usage requires a `subject`")
      const def = requireMetric(metric)
      const now = new Date()

      const quantity = await traced(tracer, "meter.usage", { "meter.subject": subject, "meter.metric": metric }, () => {
        if (!range && (p == null || p === period)) {
          return driver.readBucket({ subject, metric, bucket: bucketKey(period, now) })
        }
        const win = resolveWindow({ period: p, range }, now)
        return driver.readWindow({ subject, metric, aggregate: def.aggregate, start: win.start, end: win.end, endInclusive: win.endInclusive })
      })

      return { metric, quantity, unit: def.unit, aggregate: def.aggregate }
    },

    /**
     * Check usage against a quota. Reads current usage and compares to `limit`.
     * Note: `check` and `record` are separate calls, so a check is a point-in-time
     * read - for strict enforcement under concurrency, gate on the aggregate that
     * `record` returns.
     * @param {UsageQuery & { limit: number }} query
     * @returns {Promise<CheckResult>}
     */
    async check(query = {}) {
      const { limit } = query
      if (typeof limit !== "number" || !Number.isFinite(limit)) {
        throw new Error("check requires a finite numeric `limit`")
      }
      const { quantity, unit } = await this.usage(query)
      return {
        allowed: quantity < limit,
        used: quantity,
        remaining: Math.max(0, limit - quantity),
        limit,
        unit,
        metric: query.metric,
      }
    },

    /**
     * All declared metrics for a subject in the current billing period, ready
     * for a usage dashboard or an invoice. Metrics with no usage report `0`.
     * @param {{ subject: string }} query
     * @returns {Promise<Usage[]>}
     */
    async summary(query = {}) {
      const { subject } = query
      if (!subject) throw new Error("summary requires a `subject`")
      const now = new Date()
      const found = await driver.summary({ subject, bucket: bucketKey(period, now) })
      return Object.entries(catalog).map(([metric, def]) => ({
        metric,
        quantity: found.get(metric) ?? 0,
        unit: def.unit,
        aggregate: def.aggregate,
      }))
    },

    /**
     * Rederive the materialized aggregates from the event log. The event table
     * is the source of truth; the aggregate table is a cache maintained on each
     * `record`. If it is ever dropped, truncated, or suspected of drift, this
     * recomputes it for every declared metric. Pass `subject` to rebuild a
     * single subject instead of the whole table. Idempotent.
     * @param {{ subject?: string }} [options]
     * @returns {Promise<void>}
     */
    async rebuild(options = {}) {
      const { subject = null } = options
      if (!driver.rebuild) {
        throw new Error("this driver does not support rebuild")
      }
      const entries = Object.entries(catalog).map(([metric, def]) => ({ metric, aggregate: def.aggregate }))
      await traced(tracer, "meter.rebuild", subject ? { "meter.subject": subject } : {}, () =>
        driver.rebuild({ entries, subject }),
      )
    },

    /** Release backing resources (driver connections). */
    close() {
      return driver.close?.()
    },
  }
}
