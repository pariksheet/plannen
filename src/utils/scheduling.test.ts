import { describe, it, expect } from 'vitest'
import {
  expandAttendance,
  expandAndSuppress,
  resolveOverride,
  projectObligation,
  addMinutesToClock,
  projectDay,
  type BlackoutWindow,
} from './scheduling'
import type {
  AttendanceRow,
  ObligationRow,
  AttendanceInstanceRow,
} from '../lib/dbClient/types'

// Generic personas only — repo is PUBLIC.
function school(over: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'att-school',
    user_id: 'u',
    family_member_id: 'milo',
    name: 'Example school',
    location_id: 'loc-school',
    recurrence_rule: { frequency: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'] },
    dtstart: '2026-01-01',
    recurrence_until: null,
    time_of_day: null,
    start_time: '08:30',
    end_time: '15:45',
    priority: 0,
    active: true,
    ...over,
  }
}

function instance(over: Partial<AttendanceInstanceRow> = {}): AttendanceInstanceRow {
  return {
    attendance_id: 'a',
    family_member_id: 'milo',
    date: '2026-06-10',
    name: 'Example school',
    location_id: 'loc-school',
    start_time: '08:30',
    end_time: '15:45',
    priority: 0,
    dtstart: '2026-01-01',
    recurrence_until: null,
    ...over,
  }
}

// 2026-06-10 is a Wednesday; 2026-06-13 a Saturday.
const WED = '2026-06-10'
const SAT = '2026-06-13'

describe('expandAttendance', () => {
  it('emits an instance on a matching weekday', () => {
    const out = expandAttendance(school(), WED, WED)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ date: WED, start_time: '08:30', end_time: '15:45' })
  })

  it('emits nothing on a non-matching weekday', () => {
    expect(expandAttendance(school(), SAT, SAT)).toHaveLength(0)
  })

  it('emits nothing when inactive', () => {
    expect(expandAttendance(school({ active: false }), WED, WED)).toHaveLength(0)
  })

  it('drops instances after recurrence_until', () => {
    expect(expandAttendance(school({ recurrence_until: '2026-06-09' }), WED, WED)).toHaveLength(0)
  })
})

describe('expandAndSuppress', () => {
  it('drops the instance when a blackout covers the date', () => {
    const win: BlackoutWindow = {
      calendar_id: 'cal', starts_on: '2026-06-08', ends_on: '2026-06-12', label: 'holiday',
    }
    expect(expandAndSuppress(school(), [win], WED, WED)).toHaveLength(0)
  })

  it('keeps the instance when no blackout covers the date', () => {
    const win: BlackoutWindow = {
      calendar_id: 'cal', starts_on: '2026-07-01', ends_on: '2026-07-05', label: 'holiday',
    }
    expect(expandAndSuppress(school(), [win], WED, WED)).toHaveLength(1)
  })
})

describe('resolveOverride tie-break', () => {
  it('higher priority wins', () => {
    const a = instance({ attendance_id: 'a', priority: 0 })
    const b = instance({ attendance_id: 'b', priority: 10 })
    expect(resolveOverride([a, b])?.attendance_id).toBe('b')
  })

  it('bounded beats open-ended at equal priority', () => {
    const open = instance({ attendance_id: 'a', priority: 5, recurrence_until: null })
    const bounded = instance({ attendance_id: 'b', priority: 5, recurrence_until: '2026-08-01' })
    expect(resolveOverride([open, bounded])?.attendance_id).toBe('b')
  })

  it('later dtstart wins at equal priority/bounding', () => {
    const older = instance({ attendance_id: 'a', dtstart: '2026-01-01' })
    const newer = instance({ attendance_id: 'b', dtstart: '2026-05-01' })
    expect(resolveOverride([older, newer])?.attendance_id).toBe('b')
  })

  it('returns null on empty list', () => {
    expect(resolveOverride([])).toBeNull()
  })
})

describe('addMinutesToClock', () => {
  it('subtracts and adds', () => {
    expect(addMinutesToClock('08:30', -15)).toBe('08:15')
    expect(addMinutesToClock('15:45', 15)).toBe('16:00')
  })
})

describe('projectObligation', () => {
  const drop: ObligationRow = {
    id: 'ob-drop', user_id: 'u', derived_from_attendance_id: 'att-school',
    role: 'drop', anchor: 'start', offset_minutes: -15, location_id: null, active: true,
  }
  const pick: ObligationRow = {
    id: 'ob-pick', user_id: 'u', derived_from_attendance_id: 'att-school',
    role: 'pick', anchor: 'end', offset_minutes: 15, location_id: null, active: true,
  }

  it('picks the start anchor and inherits location', () => {
    const r = projectObligation(drop, instance())
    expect(r).toMatchObject({ role: 'drop', time: '08:15', location_id: 'loc-school' })
  })

  it('picks the end anchor', () => {
    const r = projectObligation(pick, instance())
    expect(r).toMatchObject({ role: 'pick', time: '16:00' })
  })

  it('drops (returns null) when the anchored time is absent', () => {
    expect(projectObligation(drop, instance({ start_time: null }))).toBeNull()
  })

  it('uses the obligation own location over the inherited one', () => {
    const r = projectObligation({ ...drop, location_id: 'loc-own' }, instance())
    expect(r?.location_id).toBe('loc-own')
  })
})

describe('projectDay end-to-end', () => {
  const drop: ObligationRow & { member_id: string } = {
    id: 'ob-drop', user_id: 'u', derived_from_attendance_id: 'att-school',
    role: 'drop', anchor: 'start', offset_minutes: -15, location_id: null, active: true,
    member_id: 'milo',
  }
  const pick: ObligationRow & { member_id: string } = {
    id: 'ob-pick', user_id: 'u', derived_from_attendance_id: 'att-school',
    role: 'pick', anchor: 'end', offset_minutes: 15, location_id: null, active: true,
    member_id: 'milo',
  }

  it('school + drop/pick on a weekday → drop 08:15 + pick 16:00', () => {
    const { attendancesToday, obligationsToday } = projectDay(
      WED, [school()], new Map(), [drop, pick],
    )
    expect(attendancesToday).toHaveLength(1)
    const times = obligationsToday.map((o) => `${o.role}@${o.time}`).sort()
    expect(times).toEqual(['drop@08:15', 'pick@16:00'])
  })

  it('with a blackout covering the day → empty', () => {
    const win = new Map<string, BlackoutWindow[]>([
      ['att-school', [{ calendar_id: 'cal', starts_on: '2026-06-08', ends_on: '2026-06-12', label: 'holiday' }]],
    ])
    const { attendancesToday, obligationsToday } = projectDay(WED, [school()], win, [drop, pick])
    expect(attendancesToday).toHaveLength(0)
    expect(obligationsToday).toHaveLength(0)
  })

  it('with a bounded camp at priority 10 → obligations follow to the camp', () => {
    const camp = school({
      id: 'att-camp',
      name: 'Summer camp',
      location_id: 'loc-camp',
      priority: 10,
      recurrence_until: '2026-08-01',
      dtstart: '2026-06-01',
      start_time: '09:00',
      end_time: '16:30',
    })
    const { attendancesToday, obligationsToday } = projectDay(
      WED, [school(), camp], new Map(), [drop, pick],
    )
    expect(attendancesToday).toHaveLength(2)
    // The school-derived drop/pick re-project onto the winning camp instance.
    const dropRow = obligationsToday.find((o) => o.role === 'drop')
    const pickRow = obligationsToday.find((o) => o.role === 'pick')
    expect(dropRow).toMatchObject({ time: '08:45', source_attendance_id: 'att-camp', location_id: 'loc-camp' })
    expect(pickRow).toMatchObject({ time: '16:45', source_attendance_id: 'att-camp' })
  })
})
