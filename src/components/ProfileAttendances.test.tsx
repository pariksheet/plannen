import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileAttendances } from './ProfileAttendances'

const m = vi.hoisted(() => ({
  listAttendances: vi.fn(),
  createAttendance: vi.fn(),
  updateAttendance: vi.fn(),
  deleteAttendance: vi.fn(),
  listObligations: vi.fn(),
  createObligation: vi.fn(),
  deleteObligation: vi.fn(),
  listBlackoutCalendars: vi.fn(),
  listAttendanceBlackoutLinks: vi.fn(),
  linkAttendanceBlackout: vi.fn(),
  unlinkAttendanceBlackout: vi.fn(),
}))
vi.mock('../services/scheduleAdminService', () => m)
vi.mock('../services/profileService', () => ({
  getFamilyMembers: vi.fn(async () => ({ data: [{ id: 'mem1', name: 'Milo' }], error: null })),
  getLocations: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))

beforeEach(() => {
  vi.clearAllMocks()
  m.listAttendances.mockResolvedValue({ data: [], error: null })
  m.listObligations.mockResolvedValue({ data: [], error: null })
  m.listBlackoutCalendars.mockResolvedValue({ data: [], error: null })
  m.listAttendanceBlackoutLinks.mockResolvedValue({ data: [], error: null })
})

describe('ProfileAttendances', () => {
  it('creates a weekly attendance with selected days', async () => {
    const user = userEvent.setup()
    m.createAttendance.mockResolvedValue({ data: { id: 'a1', name: 'Daycare', family_member_id: 'mem1', recurrence_rule: { frequency: 'weekly', days: ['MO', 'WE'] }, dtstart: '2026-06-15', start_time: null, end_time: null, location_id: null, priority: 0, active: true }, error: null })
    render(<ProfileAttendances />)
    await user.click(screen.getByRole('button', { name: /^attendances$/i }))
    await waitFor(() => expect(m.listAttendances).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /add attendance/i }))
    await user.type(screen.getByLabelText(/attendance name/i), 'Daycare')
    await user.click(screen.getByRole('button', { name: 'Mon' }))
    await user.click(screen.getByRole('button', { name: 'Wed' }))
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(m.createAttendance).toHaveBeenCalled())
    const arg = m.createAttendance.mock.calls[0][0]
    expect(arg.family_member_id).toBe('mem1')
    expect(arg.name).toBe('Daycare')
    expect(arg.recurrence_rule.frequency).toBe('weekly')
    expect(arg.recurrence_rule.days).toEqual(['MO', 'WE'])
  })

  it('adds a drop-off obligation to an existing attendance', async () => {
    const user = userEvent.setup()
    m.listAttendances.mockResolvedValue({ data: [{ id: 'a1', name: 'School', family_member_id: 'mem1', recurrence_rule: { frequency: 'weekly', days: ['MO'] }, dtstart: '2026-06-15', start_time: '08:30', end_time: '15:30', location_id: null, priority: 0, active: true }], error: null })
    m.createObligation.mockResolvedValue({ data: { id: 'o1', derived_from_attendance_id: 'a1', role: 'drop', anchor: 'start', offset_minutes: -15, location_id: null, active: true }, error: null })
    render(<ProfileAttendances />)
    await user.click(screen.getByRole('button', { name: /^attendances$/i }))
    await waitFor(() => expect(m.listAttendances).toHaveBeenCalled())

    await user.type(screen.getByLabelText(/school obligation offset/i), '-15')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(m.createObligation).toHaveBeenCalled())
    const arg = m.createObligation.mock.calls[0][0]
    expect(arg.derived_from_attendance_id).toBe('a1')
    expect(arg.role).toBe('drop')
    expect(arg.anchor).toBe('start')
  })
})
