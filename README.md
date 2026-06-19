<p align="center">
  <img src="logo.svg" width="80" height="80" alt="meter logo">
</p>

<h1 align="center">@prsm/meter</h1>

<p align="center">
  <a href="https://github.com/prsmjs/meter/actions/workflows/test.yml"><img src="https://github.com/prsmjs/meter/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://www.npmjs.com/package/@prsm/meter"><img src="https://img.shields.io/npm/v/@prsm/meter" alt="npm"></a>
</p>

Usage metering for billing and quotas, backed by postgres. Record what each customer consumes, read their usage for any billing period, and check it against a plan limit. The event log is the durable source of truth; per-period aggregates are maintained in the same transaction so a quota check is a single-row read.

This is a ledger, not a rate limiter. [@prsm/limit](https://www.npmjs.com/package/@prsm/limit) protects your system from too many requests per second and is fine to lose on a restart. Meter measures cumulative business usage over a billing period, has to survive restarts because it drives revenue, and never touches redis: postgres holds everything, and every write is committed before it returns.

## Installation

```bash
npm install @prsm/meter pg
```

## Quick start

```js
import { createMeter, postgresDriver } from "@prsm/meter"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const meter = createMeter({
  driver: postgresDriver({ pool }),
  period: "month", // the billing granularity (default)
  metrics: {
    api_calls:    { unit: "calls",  aggregate: "sum" },
    tokens:       { unit: "tokens", aggregate: "sum" },
    seats:        { unit: "seats",  aggregate: "max" },
    storage:      { unit: "GB",     aggregate: "last" },
    active_users: { unit: "users",  aggregate: "unique" },
  },
})

await meter.setup() // create tables if they do not exist; idempotent
```

Recording usage and enforcing a plan limit on an API request:

```js
async function handleCompletion(account, prompt) {
  const quota = await meter.check({ subject: account.id, metric: "tokens", limit: account.plan.tokenLimit })
  if (!quota.allowed) {
    throw new Error(`monthly token limit reached (${quota.used}/${quota.limit})`)
  }

  const { usage, text } = await callModel(prompt)

  await meter.record({
    subject: account.id,
    metric: "tokens",
    quantity: usage.total,
    idempotencyKey: requestId, // a retry of the same request is counted once
  })

  return text
}
```

At the end of the cycle, build an invoice line for every metric:

```js
const lines = await meter.summary({ subject: account.id })
// [
//   { metric: "api_calls",    quantity: 18204, unit: "calls",  aggregate: "sum" },
//   { metric: "tokens",       quantity: 4_120_350, unit: "tokens", aggregate: "sum" },
//   { metric: "seats",        quantity: 12, unit: "seats",  aggregate: "max" },
//   { metric: "storage",      quantity: 47.5, unit: "GB", aggregate: "last" },
//   { metric: "active_users", quantity: 31, unit: "users", aggregate: "unique" },
// ]
```

## The metric catalog

You declare every metric once, at construction. The unit and how its quantity aggregates live with the definition, so call sites only ever deal with who, what, and how much. Recording an undeclared metric throws.

| `aggregate` | combines events by | example | record with |
|---|---|---|---|
| `sum` | adding quantities | tokens, API calls, bytes | `quantity` |
| `max` | keeping the high-water mark | peak concurrent seats | `quantity` |
| `last` | keeping the most recent value (a gauge) | current GB stored | `quantity` |
| `unique` | counting distinct identifiers | monthly active users | `value` |

A `unique` metric counts distinct identifiers rather than summing a number, so its events carry a `value` (the user id, say) instead of a `quantity`:

```js
await meter.record({ subject: account.id, metric: "active_users", value: user.id })
const mau = await meter.usage({ subject: account.id, metric: "active_users" })
```

## Periods

`usage` and `check` scope to a window in one of three ways:

- a **calendar keyword** (`"minute"`, `"hour"`, `"day"`, `"week"`, `"month"`, `"year"`) selects the current calendar bucket and resets at its UTC boundary. `"month"` means "this month so far." This is the materialized fast path and the default (it matches the meter's configured `period`).
- a **duration** (`"30 days"`, `"15m"`, `"2 months"`) selects a rolling window ending now, aggregated from the event log. Sub-month spans are parsed by [@prsm/ms](https://www.npmjs.com/package/@prsm/ms); months and years use calendar arithmetic, so `"2 months"` is the same day two calendar months ago through now. When the target month has no such day (a `"1 month"` window ending March 31), the start clamps to that month's last day (February 28).
- an explicit **range** `{ start, end }` for a fixed window such as a past month or an anniversary billing cycle. Ranges are half-open, so adjacent periods tile without double-counting a boundary event.

```js
await meter.usage({ subject, metric: "tokens" })                          // current month (default)
await meter.usage({ subject, metric: "tokens", period: "day" })           // today so far
await meter.usage({ subject, metric: "tokens", period: "30 days" })       // rolling 30 days
await meter.usage({ subject, metric: "tokens", range: { start, end } })   // an exact window
```

Note that `"month"` and `"1 month"` are different on purpose: the first is the current calendar month, the second is a rolling window covering the trailing month.

## API

### `createMeter({ driver, metrics, period?, tracer? })`

Creates a meter. `driver` is `postgresDriver({ pool })` in production or `memoryDriver()` in tests. `period` is the billing granularity that gets materialized for fast reads (default `"month"`). `tracer` is an optional [@prsm/trace](https://www.npmjs.com/package/@prsm/trace) tracer; record, usage, and check are wrapped in spans when it is present.

### `meter.setup()`

Creates the backing tables if they do not exist. Idempotent, safe to call on every boot.

### `meter.record({ subject, metric, quantity?, value?, idempotencyKey?, at? })`

Records a usage event and returns the metric's new aggregate for the current period as `{ quantity, unit }`. Pass `quantity` for `sum`/`max`/`last` metrics and `value` for `unique` metrics. A repeat with the same `idempotencyKey` is a no-op and returns the unchanged aggregate, because double-counting is overbilling. `at` sets the event timestamp for backfilling (default now).

### `meter.usage({ subject, metric, period?, range? })`

Returns `{ metric, quantity, unit, aggregate }` aggregated over the window. With no `period` or `range`, returns the current billing period from the materialized aggregate.

### `meter.check({ subject, metric, limit, period?, range? })`

Reads current usage and compares it to `limit`, returning `{ allowed, used, remaining, limit, unit, metric }`. `check` and `record` are separate calls, so a check is a point-in-time read; for strict enforcement under concurrency, gate on the aggregate that `record` returns rather than checking first.

### `meter.summary({ subject })`

Returns a `usage` entry for every declared metric in the current billing period, including metrics with no usage (reported as `0`). Built for a usage dashboard or an invoice.

### `meter.catalog()`

Returns the meter's static configuration: `{ period, metrics }`, where `metrics` maps each declared metric name to its `{ unit, aggregate }`. Subject-independent and read-only, so it never touches storage. Use it to render a usage dashboard, drive admin tooling, or document what a meter tracks without first picking a subject. The returned object is a fresh copy.

### `meter.rebuild({ subject? })`

Recomputes the materialized aggregate table from the event log for every declared metric. The events are the source of truth and the aggregates are a cache, so this is how you recover from a dropped or drifted aggregate table. Pass `subject` to rebuild a single subject instead of the whole table. Idempotent.

### `meter.close()`

Releases driver resources.

## Storage

Three postgres tables, prefixed `meter_` by default (pass `prefix` to `postgresDriver` to run several meters in one database):

- `meter_events` is the append-only log of every recorded event. It is the source of truth, so "why was I charged this?" is always answerable.
- `meter_aggregates` holds the materialized per-(subject, metric, period) rollups, updated atomically alongside each event insert. It is derived data: if it is ever dropped or suspected of drift, `meter.rebuild()` recomputes it from the event log.
- `meter_unique_members` backs exact distinct counting for `unique` metrics.

There is no in-process buffering and no write-behind queue, so a crash cannot drop an event that a `record` call already acknowledged. On restart, reads come straight from postgres; there is no cache to warm.

## Testing

The `memoryDriver` mirrors the postgres driver's semantics exactly and needs no infrastructure, so unit tests run without a database:

```js
import { createMeter, memoryDriver } from "@prsm/meter"

const meter = createMeter({ driver: memoryDriver(), metrics: { tokens: { unit: "tokens", aggregate: "sum" } } })
await meter.setup()
```

It is not durable; use it for tests, not production.

## License

MIT
