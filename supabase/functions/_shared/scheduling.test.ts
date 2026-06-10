import { describe, it, expect } from 'vitest'
import {
  dateInWindow,
  isSuppressed,
  expandAttendance,
  expandAndSuppress,
  type AttendanceRow,
  type BlackoutWindow,
} from './scheduling.ts'

const weekdays: AttendanceRow = {
  id: 'a1',
  user_id: 'u1',
  family_member_id: 'fm1',
  name: 'School',
  location_id: 'loc1',
  recurrence_rule: { frequency: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'] },
  dtstart: '2026-06-01', // a Monday
  recurrence_until: null,
  start_time: '08:30',
  end_time: '15:30',
  priority: 5,
  active: true,
}

const win = (starts_on: string, ends_on: string): BlackoutWindow => ({
  calendar_id: 'c1', starts_on, ends_on, label: null,
})

describe('dateInWindow', () => {
  const w = win('2026-07-01', '2026-07-31')
  it('is true for a date inside the window', () => {
    expect(dateInWindow('2026-07-15', w)).toBe(true)
  })
  it('is true on the starts_on edge (inclusive)', () => {
    expect(dateInWindow('2026-07-01', w)).toBe(true)
  })
  it('is true on the ends_on edge (inclusive)', () => {
    expect(dateInWindow('2026-07-31', w)).toBe(true)
  })
  it('is false one day before the window', () => {
    expect(dateInWindow('2026-06-30', w)).toBe(false)
  })
  it('is false one day after the window', () => {
    expect(dateInWindow('2026-08-01', w)).toBe(false)
  })
})

describe('isSuppressed', () => {
  it('is false when there are no windows', () => {
    expect(isSuppressed('2026-07-15', [])).toBe(false)
  })
  it('is true when any window covers the date', () => {
    expect(isSuppressed('2026-07-15', [win('2026-07-01', '2026-07-31')])).toBe(true)
  })
  it('is false when no window covers the date', () => {
    expect(isSuppressed('2026-09-15', [win('2026-07-01', '2026-07-31')])).toBe(false)
  })
  it('is true when the date is covered by the 2nd of two windows', () => {
    const windows = [win('2026-07-01', '2026-07-31'), win('2026-12-20', '2027-01-05')]
    expect(isSuppressed('2026-12-25', windows)).toBe(true)
  })
})

describe('expandAttendance', () => {
  it('expands a weekdays attendance to Mon–Fri over a 7-day window', () => {
    const out = expandAttendance(weekdays, '2026-06-01', '2026-06-07')
    expect(out.map((i) => i.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
    ])
    // Sat 2026-06-06 and Sun 2026-06-07 excluded
    expect(out).toHaveLength(5)
  })

  it('carries all instance fields correctly', () => {
    const out = expandAttendance(weekdays, '2026-06-01', '2026-06-07')
    expect(out[0]).toEqual({
      attendance_id: 'a1',
      family_member_id: 'fm1',
      date: '2026-06-01',
      name: 'School',
      location_id: 'loc1',
      start_time: '08:30',
      end_time: '15:30',
      priority: 5,
      dtstart: '2026-06-01',
      recurrence_until: null,
    })
  })

  it('includes the instance exactly on dtstart', () => {
    const out = expandAttendance(weekdays, '2026-06-01', '2026-06-07')
    expect(out.map((i) => i.date)).toContain('2026-06-01')
  })

  it('excludes instances after recurrence_until', () => {
    const att: AttendanceRow = { ...weekdays, recurrence_until: '2026-06-03' }
    const out = expandAttendance(att, '2026-06-01', '2026-06-07')
    expect(out.map((i) => i.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03'])
  })

  it('returns [] when the attendance is inactive', () => {
    const att: AttendanceRow = { ...weekdays, active: false }
    expect(expandAttendance(att, '2026-06-01', '2026-06-07')).toEqual([])
  })

  it('honours a daily interval of 2', () => {
    const att: AttendanceRow = {
      ...weekdays,
      recurrence_rule: { frequency: 'daily', interval: 2 },
    }
    const out = expandAttendance(att, '2026-06-01', '2026-06-05')
    expect(out.map((i) => i.date)).toEqual(['2026-06-01', '2026-06-03', '2026-06-05'])
  })
})

describe('expandAndSuppress', () => {
  it('drops instances that fall inside a blackout window', () => {
    const out = expandAndSuppress(
      weekdays,
      [win('2026-06-03', '2026-06-04')],
      '2026-06-01',
      '2026-06-07',
    )
    // Wed 06-03 + Thu 06-04 suppressed; Mon/Tue/Fri survive
    expect(out.map((i) => i.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-05'])
  })
})
