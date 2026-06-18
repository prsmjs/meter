import ms from "@prsm/ms"

/**
 * @typedef {"minute"|"hour"|"day"|"week"|"month"|"year"} CalendarPeriod
 * A calendar bucket. Selects the *current* calendar period and resets at its
 * boundary in UTC. `"month"` means "this month so far" and rolls over on the
 * 1st; `"week"` is an ISO week starting Monday. This is the fast, materialized
 * path - the bucket key is derivable from a timestamp alone, with no per-subject
 * state. It is distinct from a duration of the same name: `"month"` is the
 * current calendar month, whereas `"1 month"` is a rolling window (see below).
 */

/**
 * @typedef {string} DurationPeriod
 * A rolling window that ends *now*, written as a duration. Sub-month spans are
 * parsed by `@prsm/ms` (`"15m"`, `"90 days"`, `"3 weeks"`, even compound forms
 * like `"1h 30m"`). Months and years use calendar arithmetic rather than a fixed
 * number of milliseconds, because they are not fixed-length: `"2 months"` is the
 * same day-of-month two calendar months ago through now. Examples: `"15m"`,
 * `"30 days"`, `"2 months"`, `"1 year"`.
 */

/**
 * @typedef {CalendarPeriod | (string & {})} Period
 * How to scope a usage query, in one of two forms:
 *
 * - a {@link CalendarPeriod} keyword (`"minute"`, `"hour"`, `"day"`, `"week"`,
 *   `"month"`, `"year"`) - the current calendar bucket, the fast path;
 * - a {@link DurationPeriod} string (`"30 days"`, `"2 months"`, `"15m"`) - a
 *   rolling window ending now, aggregated from the event log.
 *
 * For an explicit fixed window (a past month, an anniversary cycle), pass a
 * `range: { start, end }` instead of a period.
 */

/**
 * @typedef {Object} Range
 * @property {Date} start - inclusive lower bound
 * @property {Date} end - exclusive upper bound
 */

/**
 * @typedef {Object} Window
 * @property {Date} start - inclusive lower bound
 * @property {Date} end - upper bound
 * @property {boolean} endInclusive - whether `end` is inclusive. A period or
 *   duration ends at "now" inclusively so the current instant counts; an
 *   explicit range is half-open so adjacent periods tile without overlap.
 */

export const CALENDAR_UNITS = ["minute", "hour", "day", "week", "month", "year"]

const CALENDAR_DURATION = /^\s*(\d+(?:\.\d+)?)\s*(months?|mo|years?|yrs?|y)\s*$/i

/** @param {string} period */
export function isCalendarPeriod(period) {
  return typeof period === "string" && CALENDAR_UNITS.includes(period)
}

function utcParts(date) {
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth(),
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
  }
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const isoYear = d.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDay = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3)
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return { isoYear, week }
}

const pad = (n, w = 2) => String(n).padStart(w, "0")

/**
 * Calendar bucket key for a timestamp at a given granularity (UTC).
 * @param {CalendarPeriod} unit
 * @param {Date} date
 * @returns {string}
 */
export function bucketKey(unit, date) {
  const { y, mo, d, h, mi } = utcParts(date)
  switch (unit) {
    case "minute": return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}`
    case "hour": return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}`
    case "day": return `${y}-${pad(mo + 1)}-${pad(d)}`
    case "week": { const { isoYear, week } = isoWeek(date); return `${isoYear}-W${pad(week)}` }
    case "month": return `${y}-${pad(mo + 1)}`
    case "year": return `${y}`
    default: throw new Error(`unknown calendar unit "${unit}"`)
  }
}

/**
 * Start of the calendar bucket containing `date` (UTC boundary).
 * @param {CalendarPeriod} unit
 * @param {Date} date
 * @returns {Date}
 */
export function bucketStart(unit, date) {
  const { y, mo, d, h } = utcParts(date)
  switch (unit) {
    case "minute": return new Date(Date.UTC(y, mo, d, h, date.getUTCMinutes()))
    case "hour": return new Date(Date.UTC(y, mo, d, h))
    case "day": return new Date(Date.UTC(y, mo, d))
    case "week": {
      const start = new Date(Date.UTC(y, mo, d))
      const day = (start.getUTCDay() + 6) % 7
      start.setUTCDate(start.getUTCDate() - day)
      return start
    }
    case "month": return new Date(Date.UTC(y, mo, 1))
    case "year": return new Date(Date.UTC(y, 0, 1))
    default: throw new Error(`unknown calendar unit "${unit}"`)
  }
}

function subtractCalendar(date, count, unit) {
  const { y, mo, d, h, mi } = utcParts(date)
  if (unit === "month") return new Date(Date.UTC(y, mo - count, d, h, mi, date.getUTCSeconds(), date.getUTCMilliseconds()))
  return new Date(Date.UTC(y - count, mo, d, h, mi, date.getUTCSeconds(), date.getUTCMilliseconds()))
}

/**
 * Resolve a period or explicit range into a concrete time window.
 * @param {{ period?: Period, range?: Range }} query
 * @param {Date} now
 * @returns {Window}
 */
export function resolveWindow(query, now) {
  if (query.range) {
    const { start, end } = query.range
    if (!(start instanceof Date) || !(end instanceof Date)) {
      throw new Error("range must be { start: Date, end: Date }")
    }
    return { start, end, endInclusive: false }
  }

  const period = query.period
  if (isCalendarPeriod(period)) {
    return { start: bucketStart(period, now), end: now, endInclusive: true }
  }

  const calendar = CALENDAR_DURATION.exec(period)
  if (calendar) {
    const count = Math.round(parseFloat(calendar[1]))
    const unit = /^y/i.test(calendar[2]) ? "year" : "month"
    return { start: subtractCalendar(now, count, unit), end: now, endInclusive: true }
  }

  const span = ms(period, NaN)
  if (Number.isFinite(span) && span > 0) {
    return { start: new Date(now.getTime() - span), end: now, endInclusive: true }
  }

  throw new Error(
    `invalid period ${JSON.stringify(period)}. use a calendar keyword ` +
    `(${CALENDAR_UNITS.join("|")}), a duration ("30 days", "2 months", "15m"), ` +
    `or a { start, end } range`,
  )
}
