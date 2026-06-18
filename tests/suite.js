import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createMeter } from "../src/index.js"

export const CATALOG = {
  api_calls: { unit: "calls", aggregate: "sum" },
  tokens: { unit: "tokens", aggregate: "sum" },
  seats: { unit: "seats", aggregate: "max" },
  storage: { unit: "GB", aggregate: "last" },
  active_users: { unit: "users", aggregate: "unique" },
}

/**
 * Behavioral contract every driver must satisfy. Run against the in-memory and
 * postgres drivers so they stay in lockstep.
 * @param {string} label
 * @param {() => Promise<object>} makeDriver - returns a fresh, empty driver
 */
export function runMeterSuite(label, makeDriver) {
  describe(label, () => {
    let meter

    beforeEach(async () => {
      const driver = await makeDriver()
      meter = createMeter({ driver, metrics: CATALOG, period: "month" })
      await meter.setup()
    })

    afterEach(async () => {
      await meter.close()
    })

    it("sums quantities and returns the new aggregate", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 100 })
      const r = await meter.record({ subject: "a", metric: "tokens", quantity: 50 })
      expect(r).toEqual({ quantity: 150, unit: "tokens" })
      expect((await meter.usage({ subject: "a", metric: "tokens" })).quantity).toBe(150)
    })

    it("checks usage against a quota", async () => {
      await meter.record({ subject: "a", metric: "api_calls", quantity: 80 })
      expect(await meter.check({ subject: "a", metric: "api_calls", limit: 100 })).toEqual({
        allowed: true, used: 80, remaining: 20, limit: 100, unit: "calls", metric: "api_calls",
      })
      await meter.record({ subject: "a", metric: "api_calls", quantity: 40 })
      const over = await meter.check({ subject: "a", metric: "api_calls", limit: 100 })
      expect(over.allowed).toBe(false)
      expect(over.remaining).toBe(0)
    })

    it("max keeps the high-water mark", async () => {
      for (const q of [3, 7, 2]) await meter.record({ subject: "a", metric: "seats", quantity: q })
      expect((await meter.usage({ subject: "a", metric: "seats" })).quantity).toBe(7)
    })

    it("last keeps the most recent value and ignores out-of-order events", async () => {
      const base = Date.now()
      await meter.record({ subject: "a", metric: "storage", quantity: 10, at: new Date(base) })
      await meter.record({ subject: "a", metric: "storage", quantity: 5, at: new Date(base + 2000) })
      await meter.record({ subject: "a", metric: "storage", quantity: 99, at: new Date(base + 1000) })
      expect((await meter.usage({ subject: "a", metric: "storage" })).quantity).toBe(5)
    })

    it("unique counts distinct values", async () => {
      for (const v of ["u1", "u2", "u1", "u3"]) await meter.record({ subject: "a", metric: "active_users", value: v })
      expect((await meter.usage({ subject: "a", metric: "active_users" })).quantity).toBe(3)
    })

    it("dedupes by idempotency key", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 100, idempotencyKey: "k1" })
      const dup = await meter.record({ subject: "a", metric: "tokens", quantity: 100, idempotencyKey: "k1" })
      expect(dup.quantity).toBe(100)
      expect((await meter.usage({ subject: "a", metric: "tokens" })).quantity).toBe(100)
    })

    it("isolates subjects and metrics", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 100 })
      await meter.record({ subject: "b", metric: "tokens", quantity: 7 })
      await meter.record({ subject: "a", metric: "api_calls", quantity: 1 })
      expect((await meter.usage({ subject: "a", metric: "tokens" })).quantity).toBe(100)
      expect((await meter.usage({ subject: "b", metric: "tokens" })).quantity).toBe(7)
      expect((await meter.usage({ subject: "a", metric: "api_calls" })).quantity).toBe(1)
    })

    it("aggregates a rolling window from the event log", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 100 })
      await meter.record({ subject: "a", metric: "tokens", quantity: 25 })
      expect((await meter.usage({ subject: "a", metric: "tokens", period: "day" })).quantity).toBe(125)
      expect((await meter.usage({ subject: "a", metric: "active_users", period: "day" })).quantity).toBe(0)
    })

    it("summarizes every declared metric, defaulting to zero", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 100 })
      await meter.record({ subject: "a", metric: "active_users", value: "u1" })
      const summary = await meter.summary({ subject: "a" })
      const byMetric = Object.fromEntries(summary.map((s) => [s.metric, s.quantity]))
      expect(byMetric).toEqual({ api_calls: 0, tokens: 100, seats: 0, storage: 0, active_users: 1 })
      expect(summary.find((s) => s.metric === "tokens").unit).toBe("tokens")
    })

    it("rejects an unknown metric", async () => {
      await expect(meter.record({ subject: "a", metric: "nope", quantity: 1 })).rejects.toThrow(/unknown metric/)
    })

    it("requires a value for unique metrics and a quantity for numeric metrics", async () => {
      await expect(meter.record({ subject: "a", metric: "active_users", quantity: 1 })).rejects.toThrow(/unique/)
      await expect(meter.record({ subject: "a", metric: "tokens", value: "x" })).rejects.toThrow(/quantity/)
    })
  })
}
