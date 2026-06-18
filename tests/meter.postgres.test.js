import { describe, afterAll } from "vitest"
import pg from "pg"
import { runMeterSuite } from "./suite.js"
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
}
