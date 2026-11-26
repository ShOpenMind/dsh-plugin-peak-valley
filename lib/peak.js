/**
 * DeepSeek API off-peak calendar, in pure JavaScript with no dependencies.
 *
 * Official schedule (effective 2026-08-17): API requests are *peak priced* on
 * Chinese workdays 09:00–12:00 and 14:00–18:00 Beijing time. Everything else
 * is off-peak priced, which is half of the peak price. Weekends and Chinese
 * statutory holidays are off-peak all day — holidays are exempt, so a holiday
 * that falls on a weekday is still billed as off-peak.
 *
 * The holiday table is *data*, not logic: refresh HOLIDAY_RANGES when the
 * State Council publishes the next year's arrangement, and keep
 * HOLIDAY_COVERAGE in sync so the status view can warn about stale data.
 *
 * China has no daylight saving time, so a fixed +08:00 offset is exact.
 * All functions take and return Unix epoch milliseconds (UTC instants) and
 * only convert to Beijing civil time for the calendar decisions.
 */

/** Milliseconds from UTC to Beijing civil time (UTC+8, no DST). */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Peak windows as minutes after Beijing midnight: 09:00–12:00 and 14:00–18:00. */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze([9 * 60, 12 * 60]),
  Object.freeze([14 * 60, 18 * 60]),
])

/** The calendar year the built-in holiday table covers. */
export const HOLIDAY_COVERAGE = '2026'

/**
 * Chinese statutory holiday ranges (inclusive, Beijing calendar dates) as
 * published by the State Council for 2026. Weekends adjacent to these ranges
 * are already off-peak, so only the weekday dates matter for pricing.
 */
export const HOLIDAY_RANGES = Object.freeze([
  Object.freeze(['2026-01-01', '2026-01-03']),
  Object.freeze(['2026-02-15', '2026-02-23']),
  Object.freeze(['2026-04-04', '2026-04-06']),
  Object.freeze(['2026-05-01', '2026-05-05']),
  Object.freeze(['2026-06-19', '2026-06-21']),
  Object.freeze(['2026-09-25', '2026-09-27']),
  Object.freeze(['2026-10-01', '2026-10-07']),
])

/** Every statutory holiday date within {@link HOLIDAY_RANGES}. */
export const HOLIDAYS = new Set(expandHolidays(HOLIDAY_RANGES))

/**
 * Expand inclusive `YYYY-MM-DD` ranges into individual date keys.
 * @param {readonly (readonly [string, string])[]} ranges - inclusive ranges.
 * @returns {string[]} every date key in the ranges.
 */
export function expandHolidays(ranges) {
  const days = []
  for (const [from, to] of ranges) {
    const end = Date.parse(`${to}T00:00:00Z`)
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10))
    }
  }
  return days
}

/**
 * Read one instant's Beijing civil calendar fields.
 * @param {number} utcMs - Unix epoch milliseconds.
 * @returns {{ dateKey: string, weekday: number, minutes: number, hour: number, minute: number }} calendar fields.
 */
export function beijingOf(utcMs) {
  const d = new Date(utcMs + BEIJING_OFFSET_MS)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return {
    dateKey: `${year}-${month}-${day}`,
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

/**
 * Whether one instant falls in DeepSeek's peak-priced window.
 * @param {number} utcMs - Unix epoch milliseconds.
 * @param {Set<string>} [holidays] - statutory holiday date keys.
 * @returns {boolean} true when the instant is peak priced.
 */
export function isPeak(utcMs, holidays = HOLIDAYS) {
  const { dateKey, weekday, minutes } = beijingOf(utcMs)
  if (weekday === 0 || weekday === 6) return false
  if (holidays.has(dateKey)) return false
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/**
 * The first whole minute after `utcMs` that is off-peak priced.
 *
 * The gate only asks during a peak window, so in practice this returns the
 * end of that window (12:00 or 18:00 Beijing time). The function still works
 * for any instant: when `utcMs` is already off-peak it returns the next
 * minute boundary.
 * @param {number} utcMs - Unix epoch milliseconds.
 * @param {Set<string>} [holidays] - statutory holiday date keys.
 * @returns {number} the first off-peak minute boundary after `utcMs`.
 */
export function nextOffPeak(utcMs, holidays = HOLIDAYS) {
  let t = Math.floor(utcMs / 60_000) * 60_000 + 60_000
  // Eight days is more than enough: no peak window is longer than four hours
  // and every weekend offers an off-peak minute, so this always terminates.
  for (let i = 0; i < 8 * 1440; i++, t += 60_000) {
    if (!isPeak(t, holidays)) return t
  }
  throw new Error('peak-valley: no off-peak minute found within eight days')
}

/**
 * Format one instant as Beijing civil time `MM-DD HH:mm`.
 * @param {number} utcMs - Unix epoch milliseconds.
 * @returns {string} Beijing wall-clock label.
 */
export function formatBeijing(utcMs) {
  const d = new Date(utcMs + BEIJING_OFFSET_MS)
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hour = String(d.getUTCHours()).padStart(2, '0')
  const minute = String(d.getUTCMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

/**
 * Whether the built-in holiday table covers one instant's Beijing year.
 * @param {number} utcMs - Unix epoch milliseconds.
 * @returns {boolean} true when the table is current for that year.
 */
export function holidayTableCovers(utcMs) {
  return String(new Date(utcMs + BEIJING_OFFSET_MS).getUTCFullYear()) === HOLIDAY_COVERAGE
}
