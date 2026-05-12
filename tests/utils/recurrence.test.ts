import { describe, it, expect } from 'vitest'
import { generateSessionDates } from '../../src/utils/recurrence'

const ONE_DAY_MS   = 24 * 60 * 60 * 1_000
const ONE_WEEK_MS  = 7 * ONE_DAY_MS

describe('generateSessionDates', () => {
  describe('daily', () => {
    it('returns the correct count', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 3,
      })
      expect(results).toHaveLength(3)
    })

    it('spaces sessions exactly one day apart', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 3,
      })
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(ONE_DAY_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(ONE_DAY_MS)
    })

    it('respects interval', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        interval: 2,
        count: 3,
      })
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(2 * ONE_DAY_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(2 * ONE_DAY_MS)
    })

    it('stops on or before until date', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        until: '2026-01-03T23:59:59Z',
      })
      expect(results).toHaveLength(3) // Jan 1, 2, 3
      expect(results.every(r => r.start <= new Date('2026-01-03T23:59:59Z'))).toBe(true)
    })

    it('returns empty array when neither count nor until is given', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
      })
      expect(results).toHaveLength(0)
    })

    it('attaches correct end date when session_duration_minutes is set', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 1,
        session_duration_minutes: 90,
      })
      expect(results[0].end).not.toBeNull()
      const durationMs = results[0].end!.getTime() - results[0].start.getTime()
      expect(durationMs).toBe(90 * 60_000)
    })

    it('sets end to null when session_duration_minutes is not set', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 1,
      })
      expect(results[0].end).toBeNull()
    })
  })

  describe('weekly', () => {
    it('generates sessions only on the specified days', () => {
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO', 'WE'],
        count: 4,
      })
      expect(results).toHaveLength(4)
      // MO→WE = 2 days, WE→next MO = 5 days, repeat — timezone-independent
      const gaps = results.slice(1).map((r, i) =>
        Math.round((r.start.getTime() - results[i].start.getTime()) / ONE_DAY_MS)
      )
      expect(gaps).toEqual([2, 5, 2])
    })

    it('produces sessions in chronological order', () => {
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO', 'WE', 'FR'],
        count: 6,
      })
      for (let i = 1; i < results.length; i++) {
        expect(results[i].start.getTime()).toBeGreaterThan(results[i - 1].start.getTime())
      }
    })

    it('advances by interval weeks between same-day sessions', () => {
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO'],
        interval: 2,
        count: 3,
      })
      expect(results).toHaveLength(3)
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(2 * ONE_WEEK_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(2 * ONE_WEEK_MS)
    })
  })

  describe('monthly', () => {
    it('returns the correct count', () => {
      const results = generateSessionDates('2026-01-15T00:00:00Z', {
        frequency: 'monthly',
        count: 4,
      })
      expect(results).toHaveLength(4)
    })

    it('advances by one calendar month each session', () => {
      const results = generateSessionDates('2026-01-15T00:00:00Z', {
        frequency: 'monthly',
        count: 3,
      })
      expect(results[0].start.getUTCMonth()).toBe(0) // January
      expect(results[1].start.getUTCMonth()).toBe(1) // February
      expect(results[2].start.getUTCMonth()).toBe(2) // March
    })

    it('respects interval for monthly recurrence', () => {
      const results = generateSessionDates('2026-01-15T00:00:00Z', {
        frequency: 'monthly',
        interval: 3,
        count: 2,
      })
      expect(results).toHaveLength(2)
      const gapDays = (results[1].start.getTime() - results[0].start.getTime()) / ONE_DAY_MS
      expect(gapDays).toBeGreaterThanOrEqual(89) // ~3 months
      expect(gapDays).toBeLessThanOrEqual(93)
    })
  })
})
