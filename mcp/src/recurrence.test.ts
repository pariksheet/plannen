import { describe, it, expect } from 'vitest'
import { generateSessionDates } from './recurrence.js'

describe('generateSessionDates — weekly with date-only `until`', () => {
  it('includes a session on the `until` day even when its UTC time is past midnight', () => {
    // Niheet's Swimming Class regression: 12:30 Europe/Brussels (10:30 UTC) on Sat Jun 20.
    // Pre-fix, `new Date('2026-06-20')` parsed as 2026-06-20T00:00:00Z so the Jun 20 cursor
    // (10:30 UTC) was > until → loop broke before makeEntry, dropping the last session.
    const sessions = generateSessionDates('2026-04-25T12:30:00+02:00', {
      frequency: 'weekly',
      days: ['SA'],
      until: '2026-06-20',
      session_duration_minutes: 30,
    })

    expect(sessions).toHaveLength(9)
    expect(sessions[0].start.toISOString()).toBe('2026-04-25T10:30:00.000Z')
    expect(sessions[8].start.toISOString()).toBe('2026-06-20T10:30:00.000Z')
    expect(sessions[8].end?.toISOString()).toBe('2026-06-20T11:00:00.000Z')
  })

  it('still respects `until` when it is given as a full ISO datetime', () => {
    const sessions = generateSessionDates('2026-04-25T12:30:00+02:00', {
      frequency: 'weekly',
      days: ['SA'],
      until: '2026-06-13T23:59:59Z',
      session_duration_minutes: 30,
    })
    expect(sessions).toHaveLength(8)
    expect(sessions.at(-1)?.start.toISOString()).toBe('2026-06-13T10:30:00.000Z')
  })

  it('honours `count` over `until` when both would otherwise apply', () => {
    const sessions = generateSessionDates('2026-04-25T12:30:00+02:00', {
      frequency: 'weekly',
      days: ['SA'],
      count: 3,
      until: '2026-06-20',
    })
    expect(sessions).toHaveLength(3)
  })
})

describe('generateSessionDates — daily and monthly inclusive `until`', () => {
  it('daily frequency includes the `until` day', () => {
    const sessions = generateSessionDates('2026-05-01T09:00:00Z', {
      frequency: 'daily',
      until: '2026-05-05',
    })
    // 5 days: May 1, 2, 3, 4, 5
    expect(sessions).toHaveLength(5)
    expect(sessions.at(-1)?.start.toISOString()).toBe('2026-05-05T09:00:00.000Z')
  })

  it('monthly frequency includes the `until` month', () => {
    const sessions = generateSessionDates('2026-01-15T10:00:00Z', {
      frequency: 'monthly',
      until: '2026-04-15',
    })
    // Jan, Feb, Mar, Apr
    expect(sessions).toHaveLength(4)
    expect(sessions.at(-1)?.start.toISOString()).toBe('2026-04-15T10:00:00.000Z')
  })
})

describe('generateSessionDates — early termination', () => {
  it('returns empty array when neither count nor until is given', () => {
    const sessions = generateSessionDates('2026-05-01T09:00:00Z', {
      frequency: 'daily',
    })
    expect(sessions).toHaveLength(0)
  })
})

describe('generateSessionDates — DST handling', () => {
  it('preserves 18:15 Europe/Brussels across the CEST→CET transition', () => {
    // Niheet's inline-skating regression: parent created in CEST (UTC+2),
    // sessions after Oct 25 should remain at 18:15 local (= 17:15Z under CET).
    const sessions = generateSessionDates(
      '2026-10-21T16:15:00Z',
      { frequency: 'weekly', days: ['WE'], until: '2026-11-11', session_duration_minutes: 75 },
      'Europe/Brussels',
    )
    expect(sessions.map((s) => s.start.toISOString())).toEqual([
      '2026-10-21T16:15:00.000Z',
      '2026-10-28T17:15:00.000Z',
      '2026-11-04T17:15:00.000Z',
      '2026-11-11T17:15:00.000Z',
    ])
    expect(sessions.at(-1)?.end?.toISOString()).toBe('2026-11-11T18:30:00.000Z')
  })

  it('preserves 18:15 Europe/Brussels across the CET→CEST transition', () => {
    const sessions = generateSessionDates(
      '2026-03-25T17:15:00Z',
      { frequency: 'weekly', days: ['WE'], until: '2026-04-08', session_duration_minutes: 75 },
      'Europe/Brussels',
    )
    expect(sessions.map((s) => s.start.toISOString())).toEqual([
      '2026-03-25T17:15:00.000Z',
      '2026-04-01T16:15:00.000Z',
      '2026-04-08T16:15:00.000Z',
    ])
  })
})
