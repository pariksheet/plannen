import { describe, it, expect } from 'vitest'
import {
  dateInWindow,
  isSuppressed,
  expandAttendance,
  expandAndSuppress,
  addMinutesToClock,
  resolveOverride,
  projectObligation,
  type AttendanceRow,
  type AttendanceInstance,
  type BlackoutWindow,
  type ObligationRow,
} from './scheduling.ts'

// Build an AttendanceInstance with sensible defaults for Phase 3 tests.
const inst = (over: Partial<AttendanceInstance> = {}): AttendanceInstance => ({
  attendance_id: 'a1',
  family_member_id: 'fm1',
  date: '2026-06-15',
  name: 'instance',
  location_id: null,
  start_time: '08:30',
  end_time: '16:00',
  priority: 0,
  dtstart: '2026-01-05',
  recurrence_until: null,
  ...over,
})

const obl = (over: Partial<ObligationRow> = {}): ObligationRow => ({
  id: 'ob1',
  user_id: 'u1',
  derived_from_attendance_id: 'a1',
  role: 'drop',
  anchor: 'start',
  offset_minutes: -15,
  location_id: null,
  active: true,
  ...over,
})

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

describe('addMinutesToClock', () => {
  it('subtracts 15 minutes across no boundary', () => {
    expect(addMinutesToClock('08:30', -15)).toBe('08:15')
  })
  it('subtracts 15 minutes across the hour boundary', () => {
    expect(addMinutesToClock('08:05', -15)).toBe('07:50')
  })
  it('subtracts 45 minutes', () => {
    expect(addMinutesToClock('08:30', -45)).toBe('07:45')
  })
  it('is a no-op for offset 0', () => {
    expect(addMinutesToClock('16:00', 0)).toBe('16:00')
  })
  it('adds 30 minutes', () => {
    expect(addMinutesToClock('09:00', 30)).toBe('09:30')
  })
})

describe('resolveOverride', () => {
  it('returns null for an empty list', () => {
    expect(resolveOverride([])).toBe(null)
  })

  it('returns the single instance unchanged', () => {
    const only = inst({ attendance_id: 'school' })
    expect(resolveOverride([only])).toBe(only)
  })

  it('higher priority wins (camp 10 beats school 0)', () => {
    const school = inst({ attendance_id: 'school', priority: 0 })
    const camp = inst({ attendance_id: 'camp', priority: 10 })
    expect(resolveOverride([school, camp])).toBe(camp)
    // order-independent
    expect(resolveOverride([camp, school])).toBe(camp)
  })

  it('tie at equal priority: bounded beats open-ended', () => {
    const school = inst({
      attendance_id: 'school',
      priority: 0,
      recurrence_until: null,
      dtstart: '2026-01-05',
    })
    const camp = inst({
      attendance_id: 'camp',
      priority: 0,
      recurrence_until: '2026-07-11',
      dtstart: '2026-07-07',
    })
    expect(resolveOverride([school, camp])).toBe(camp)
    expect(resolveOverride([camp, school])).toBe(camp)
  })

  it('residual tie (both bounded, equal priority): later dtstart wins', () => {
    const early = inst({
      attendance_id: 'early',
      priority: 0,
      recurrence_until: '2026-07-11',
      dtstart: '2026-07-01',
    })
    const late = inst({
      attendance_id: 'late',
      priority: 0,
      recurrence_until: '2026-07-20',
      dtstart: '2026-07-07',
    })
    expect(resolveOverride([early, late])).toBe(late)
    expect(resolveOverride([late, early])).toBe(late)
  })

  it('residual tie with equal dtstart: lower attendance_id wins', () => {
    const a = inst({
      attendance_id: 'aaa',
      priority: 0,
      recurrence_until: null,
      dtstart: '2026-07-07',
    })
    const b = inst({
      attendance_id: 'bbb',
      priority: 0,
      recurrence_until: null,
      dtstart: '2026-07-07',
    })
    expect(resolveOverride([a, b])).toBe(a)
    expect(resolveOverride([b, a])).toBe(a)
  })
})

describe('projectObligation', () => {
  it('drop: anchors at start with a negative offset, inherits winner location', () => {
    const ob = obl({ role: 'drop', anchor: 'start', offset_minutes: -15, location_id: null })
    const winner = inst({
      start_time: '08:30',
      end_time: '16:00',
      location_id: 'loc-school',
      name: 'example school',
      attendance_id: 'school',
      date: '2026-06-15',
    })
    expect(projectObligation(ob, winner)).toEqual({
      obligation_id: ob.id,
      role: 'drop',
      date: '2026-06-15',
      time: '08:15',
      location_id: 'loc-school',
      source_attendance_id: 'school',
      source_name: 'example school',
    })
  })

  it('pick: anchors at end with offset 0', () => {
    const ob = obl({ role: 'pick', anchor: 'end', offset_minutes: 0 })
    const winner = inst({
      start_time: '08:30',
      end_time: '16:00',
      location_id: 'loc-school',
      name: 'example school',
      attendance_id: 'school',
      date: '2026-06-15',
    })
    expect(projectObligation(ob, winner)?.time).toBe('16:00')
  })

  it('pick on a Wednesday winner with early end has no special rule', () => {
    const ob = obl({ role: 'pick', anchor: 'end', offset_minutes: 0 })
    const winner = inst({ end_time: '12:00' })
    expect(projectObligation(ob, winner)?.time).toBe('12:00')
  })

  it('location inheritance: null obligation location inherits winner location', () => {
    const ob = obl({ location_id: null })
    const winner = inst({ location_id: 'loc-camp' })
    expect(projectObligation(ob, winner)?.location_id).toBe('loc-camp')
  })

  it("location override: obligation's own location wins", () => {
    const ob = obl({ location_id: 'loc-override' })
    const winner = inst({ location_id: 'loc-camp' })
    expect(projectObligation(ob, winner)?.location_id).toBe('loc-override')
  })

  it('returns null when the anchored start_time is null (drop)', () => {
    const ob = obl({ role: 'drop', anchor: 'start', offset_minutes: -15 })
    const winner = inst({ start_time: null })
    expect(projectObligation(ob, winner)).toBe(null)
  })

  it('returns null when the anchored end_time is null (pick)', () => {
    const ob = obl({ role: 'pick', anchor: 'end', offset_minutes: 0 })
    const winner = inst({ end_time: null })
    expect(projectObligation(ob, winner)).toBe(null)
  })
})
