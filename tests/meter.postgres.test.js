import { describe, it, expect, beforeEach, afterAll } from "vitest"
import pg from "pg"
import { runMeterSuite, CATALOG } from "./suite.js"
import { createMeter } from "../src/index.js"
import { postgresDriver } from "../src/postgresDriver.js"

const url = process.env.METER_TEST_POSTGRES_URL

if (!url) {
  describe.skip("meter (postgres) - set METER_TEST_POSTGRES_URL to run", () => {})
} else {
  const pool = new pg.Pool({ connectionString: url })
  const prefix = "meter_test"

  afterAll(async () => {
    await pool.query(`drop table if exists ${prefix}_events, ${prefix}_aggregates, ${prefix}_unique_members`)
    await pool.end()
  })

  runMeterSuite("meter (postgres)", async () => {
    const driver = postgresDriver({ pool, prefix })
    await driver.setup()
    await pool.query(`truncate ${prefix}_events, ${prefix}_aggregates, ${prefix}_unique_members`)
    return driver
  })

  describe("meter (postgres) recovery", () => {
    let meter

    beforeEach(async () => {
      meter = createMeter({ driver: postgresDriver({ pool, prefix }), metrics: CATALOG, period: "month" })
      await meter.setup()
      await pool.query(`truncate ${prefix}_events, ${prefix}_aggregates, ${prefix}_unique_members`)
    })

    it("rebuilds the aggregate cache after it is dropped, from the event log alone", async () => {
      await meter.record({ subject: "a", metric: "tokens", quantity: 1000 })
      await meter.record({ subject: "a", metric: "seats", quantity: 9 })
      for (const v of ["u1", "u2", "u3"]) await meter.record({ subject: "a", metric: "active_users", value: v })

      const before = await meter.usage({ subject: "a", metric: "tokens" })
      expect(before.quantity).toBe(1000)

      // the aggregate table and its unique-members index are derived data
      await pool.query(`truncate ${prefix}_aggregates, ${prefix}_unique_members`)
      expect((await meter.usage({ subject: "a", metric: "tokens" })).quantity).toBe(0)

      await meter.rebuild()

      expect((await meter.usage({ subject: "a", metric: "tokens" })).quantity).toBe(1000)
      expect((await meter.usage({ subject: "a", metric: "seats" })).quantity).toBe(9)
      expect((await meter.usage({ subject: "a", metric: "active_users" })).quantity).toBe(3)

      // the rebuilt members index keeps distinct counting exact going forward
      await meter.record({ subject: "a", metric: "active_users", value: "u1" })
      expect((await meter.usage({ subject: "a", metric: "active_users" })).quantity).toBe(3)
    })
  })
}
