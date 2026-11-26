import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BEIJING_OFFSET_MS,
  HOLIDAY_RANGES,
  HOLIDAYS,
  beijingOf,
  expandHolidays,
  formatBeijing,
  holidayTableCovers,
  isPeak,
  nextOffPeak,
} from '../lib/peak.js'

const at = iso => Date.parse(iso)

test('beijingOf converts an instant to Beijing civil time', () => {
  const fields = beijingOf(at('2026-11-26T02:00:00Z'))
  assert.equal(fields.dateKey, '2026-11-26')
  assert.equal(fields.hour, 10)
  assert.equal(fields.minute, 0)
  assert.equal(fields.minutes, 600)
  assert.equal(fields.weekday, 4)
  assert.equal(BEIJING_OFFSET_MS, 8 * 60 * 60 * 1000)
})

test('peak windows are inclusive of the start and exclusive of the end', () => {
  assert.equal(isPeak(at('2026-11-26T00:59:00Z')), false) // 08:59
  assert.equal(isPeak(at('2026-11-26T01:00:00Z')), true) // 09:00
  assert.equal(isPeak(at('2026-11-26T03:59:00Z')), true) // 11:59
  assert.equal(isPeak(at('2026-11-26T04:00:00Z')), false) // 12:00
  assert.equal(isPeak(at('2026-11-26T05:59:00Z')), false) // 13:59
  assert.equal(isPeak(at('2026-11-26T06:00:00Z')), true) // 14:00
  assert.equal(isPeak(at('2026-11-26T09:59:00Z')), true) // 17:59
  assert.equal(isPeak(at('2026-11-26T10:00:00Z')), false) // 18:00
})

test('weekends are off-peak all day', () => {
  assert.equal(isPeak(at('2026-11-28T02:00:00Z')), false) // Saturday 10:00
  assert.equal(isPeak(at('2026-11-29T06:00:00Z')), false) // Sunday 14:00
})

test('statutory holidays are off-peak and the day after is not', () => {
  assert.equal(isPeak(at('2026-10-01T02:00:00Z')), false) // National Day, Thursday
  assert.equal(isPeak(at('2026-10-07T02:00:00Z')), false) // holiday tail
  assert.equal(isPeak(at('2026-10-08T02:00:00Z')), true) // Thursday after the break
})

test('holiday table expands to inclusive dates', () => {
  const flat = expandHolidays([['2026-01-01', '2026-01-03']])
  assert.deepEqual(flat, ['2026-01-01', '2026-01-02', '2026-01-03'])
  assert.equal(HOLIDAYS.size, 33)
  assert.equal(HOLIDAYS.has('2026-02-15'), true)
  assert.equal(HOLIDAYS.has('2026-02-24'), false)
  assert.equal(HOLIDAY_RANGES.length, 7)
})

test('nextOffPeak returns the end of the current peak window', () => {
  assert.equal(nextOffPeak(at('2026-11-26T02:00:00Z')), at('2026-11-26T04:00:00Z')) // 10:00 → 12:00
  assert.equal(nextOffPeak(at('2026-11-26T09:59:00Z')), at('2026-11-26T10:00:00Z')) // 17:59 → 18:00
})

test('nextOffPeak steps past a Friday window into the weekend', () => {
  assert.equal(nextOffPeak(at('2026-11-27T09:00:00Z')), at('2026-11-27T10:00:00Z'))
  assert.equal(nextOffPeak(at('2026-11-27T10:00:00Z')), at('2026-11-27T10:01:00Z')) // Saturday is off-peak
})

test('nextOffPeak honours the holiday table', () => {
  // 2026-09-25 is a statutory holiday Friday; the whole day is off-peak.
  assert.equal(nextOffPeak(at('2026-09-25T02:00:00Z')), at('2026-09-25T02:01:00Z'))
})

test('formatBeijing renders month-day and wall clock', () => {
  assert.equal(formatBeijing(at('2026-11-26T04:00:00Z')), '11-26 12:00')
  assert.equal(formatBeijing(at('2026-01-02T16:05:00Z')), '01-03 00:05')
})

test('holidayTableCovers only accepts the built-in year', () => {
  assert.equal(holidayTableCovers(at('2026-06-01T00:00:00Z')), true)
  assert.equal(holidayTableCovers(at('2027-06-01T00:00:00Z')), false)
})
