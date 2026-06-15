import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileBlackouts } from './ProfileBlackouts'

const m = vi.hoisted(() => ({
  listBlackoutCalendars: vi.fn(),
  listBlackoutWindows: vi.fn(),
  createBlackoutCalendar: vi.fn(),
  deleteBlackoutCalendar: vi.fn(),
  addBlackoutWindow: vi.fn(),
  deleteBlackoutWindow: vi.fn(),
}))
vi.mock('../services/scheduleAdminService', () => m)
vi.mock('../services/profileService', () => ({ getFamilyMembers: vi.fn(async () => ({ data: [], error: null })) }))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))

beforeEach(() => {
  vi.clearAllMocks()
  m.listBlackoutCalendars.mockResolvedValue({ data: [], error: null })
  m.listBlackoutWindows.mockResolvedValue({ data: [], error: null })
})

describe('ProfileBlackouts', () => {
  it('creates a calendar then adds a window', async () => {
    const user = userEvent.setup()
    m.createBlackoutCalendar.mockResolvedValue({ data: { id: 'c1', name: 'Holidays', family_member_id: null, active: true }, error: null })
    m.addBlackoutWindow.mockResolvedValue({ data: { id: 'w1', calendar_id: 'c1', starts_on: '2026-07-01', ends_on: '2026-07-15', label: 'Summer' }, error: null })
    render(<ProfileBlackouts />)
    await user.click(screen.getByRole('button', { name: /blackout calendars/i }))
    await waitFor(() => expect(m.listBlackoutCalendars).toHaveBeenCalled())

    await user.type(screen.getByLabelText(/new calendar name/i), 'Holidays')
    await user.click(screen.getByRole('button', { name: /add calendar/i }))
    await waitFor(() => expect(m.createBlackoutCalendar).toHaveBeenCalledWith('Holidays', null))
    expect(await screen.findByText('Holidays')).toBeInTheDocument()

    // Window inputs are namespaced by calendar name.
    await user.type(screen.getByLabelText(/holidays window start/i), '2026-07-01')
    await user.type(screen.getByLabelText(/holidays window end/i), '2026-07-15')
    await user.click(screen.getByRole('button', { name: /add range/i }))
    await waitFor(() => expect(m.addBlackoutWindow).toHaveBeenCalled())
    const arg = m.addBlackoutWindow.mock.calls[0][0]
    expect(arg.calendar_id).toBe('c1')
    expect(arg.starts_on).toBe('2026-07-01')
    expect(arg.ends_on).toBe('2026-07-15')
  })
})
