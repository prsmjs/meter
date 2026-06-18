import { describe, it, expect } from "vitest"
import { bucketKey, bucketStart, resolveWindow, isCalendarPeriod } from "../src/period.js"

const now = new Date("2026-06-18T14:30:45.123Z") // a Thursday

describe("bucketKey", () => {
  it("formats each calendar granularity in UTC", () => {
    expect(bucketKey("minute", now)).toBe("2026-06-18T14:30")
    expect(bucketKey("hour", now)).toBe("2026-06-18T14")
    expect(bucketKey("day", now)).toBe("2026-06-18")
    expect(bucketKey("week", now)).toBe("2026-W25")
    expect(bucketKey("month", now)).toBe("2026-06")
    expect(bucketKey("year", now)).toBe("2026")
  })

  it("keeps two days of the same ISO week in one bucket", () => {
    expect(bucketKey("week", new Date("2026-06-15T00:00:00Z"))).toBe("2026-W25") // Monday
    expect(bucketKey("week", new Date("2026-06-21T23:59:59Z"))).toBe("2026-W25") // Sunday
    expect(bucketKey("week", new Date("2026-06-22T00:00:00Z"))).toBe("2026-W26") // next Monday
  })
})

describe("bucketStart", () => {
  it("truncates to the UTC boundary", () => {
    expect(bucketStart("day", now).toISOString()).toBe("2026-06-18T00:00:00.000Z")
    expect(bucketStart("month", now).toISOString()).toBe("2026-06-01T00:00:00.000Z")
    expect(bucketStart("year", now).toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(bucketStart("week", now).toISOString()).toBe("2026-06-15T00:00:00.000Z") // Monday
  })
})

describe("isCalendarPeriod", () => {
  it("recognizes bare unit keywords only", () => {
    expect(isCalendarPeriod("month")).toBe(true)
    expect(isCalendarPeriod("week")).toBe(true)
    expect(isCalendarPeriod("1 month")).toBe(false)
    expect(isCalendarPeriod("30 days")).toBe(false)
  })
})

describe("resolveWindow", () => {
  it("calendar keyword resolves to [bucket start, now]", () => {
    const w = resolveWindow({ period: "month" }, now)
    expect(w.start.toISOString()).toBe("2026-06-01T00:00:00.000Z")
    expect(w.end).toBe(now)
  })

  it("sub-month durations go through @prsm/ms", () => {
    const w = resolveWindow({ period: "15m" }, now)
    expect(w.start.toISOString()).toBe("2026-06-18T14:15:45.123Z")
    expect(resolveWindow({ period: "30 days" }, now).start.toISOString()).toBe("2026-05-19T14:30:45.123Z")
  })

  it("month and year durations use calendar arithmetic", () => {
    expect(resolveWindow({ period: "2 months" }, now).start.toISOString()).toBe("2026-04-18T14:30:45.123Z")
    expect(resolveWindow({ period: "1 year" }, now).start.toISOString()).toBe("2025-06-18T14:30:45.123Z")
  })

  it("distinguishes the calendar keyword from the duration of the same name", () => {
    expect(resolveWindow({ period: "month" }, now).start.toISOString()).toBe("2026-06-01T00:00:00.000Z")
    expect(resolveWindow({ period: "1 month" }, now).start.toISOString()).toBe("2026-05-18T14:30:45.123Z")
  })

  it("passes an explicit range through", () => {
    const start = new Date("2026-01-01T00:00:00Z")
    const end = new Date("2026-02-01T00:00:00Z")
    expect(resolveWindow({ range: { start, end } }, now)).toEqual({ start, end, endInclusive: false })
  })

  it("throws on an unparseable period", () => {
    expect(() => resolveWindow({ period: "banana" }, now)).toThrow(/invalid period/)
  })
})
