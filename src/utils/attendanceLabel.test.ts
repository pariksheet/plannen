import { describe, it, expect } from 'vitest'
import { attendanceLabel } from './attendanceLabel'
import type { AttendanceInstanceRow } from '../lib/dbClient/types'

function inst(overrides: Partial<AttendanceInstanceRow> = {}): AttendanceInstanceRow {
  return {
    attendance_id: 'a1',
    family_member_id: 'm1',
    date: '2026-06-10',
    name: 'example school',
    location_id: null,
    start_time: null,
    end_time: null,
    priority: 0,
    dtstart: '2026-01-01',
    recurrence_until: null,
    ...overrides,
  }
}

describe('attendanceLabel', () => {
  it('renders name with a time range when both times are present', () => {
    expect(attendanceLabel(inst({ start_time: '08:30', end_time: '15:30' })))
      .toBe('example school (08:30–15:30)')
  })

  it('uses an en dash, not a hyphen, between times', () => {
    expect(attendanceLabel(inst({ start_time: '09:00', end_time: '12:00' })))
      .toContain('–')
  })

  it('returns just the name when both times are null', () => {
    expect(attendanceLabel(inst())).toBe('example school')
  })

  it('shows a from-time when only start_time is present', () => {
    expect(attendanceLabel(inst({ start_time: '08:30' })))
      .toBe('example school (from 08:30)')
  })

  it('shows an until-time when only end_time is present', () => {
    expect(attendanceLabel(inst({ end_time: '15:30' })))
      .toBe('example school (until 15:30)')
  })
})
