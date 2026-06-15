import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileRoutines } from './ProfileRoutines'

const mockList = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockDelete = vi.fn()

vi.mock('../services/practiceService', () => ({
  listPractices: (...a: unknown[]) => mockList(...a),
  createPractice: (...a: unknown[]) => mockCreate(...a),
  updatePractice: (...a: unknown[]) => mockUpdate(...a),
  deletePractice: (...a: unknown[]) => mockDelete(...a),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([])
})

describe('ProfileRoutines', () => {
  it('creates a weekly pinned routine with the selected days', async () => {
    const user = userEvent.setup()
    mockCreate.mockResolvedValue({
      id: 'p1', name: 'Morning run', category: 'health', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'weekly', days: ['MO', 'WE'] }, active: true,
      flex_period: null, flex_target: null, preferred_time_of_day: 'morning', dtstart: '2026-06-15',
    })
    render(<ProfileRoutines />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /add routine/i }))
    await user.type(screen.getByLabelText(/^name/i), 'Morning run')
    // Weekly is the default pinned frequency; pick two weekdays.
    await user.click(screen.getByRole('button', { name: 'Mon' }))
    await user.click(screen.getByRole('button', { name: 'Wed' }))
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    const arg = mockCreate.mock.calls[0][0] as {
      name: string; recurrence_mode: string; recurrence_rule: { frequency: string; days: string[] }
    }
    expect(arg.name).toBe('Morning run')
    expect(arg.recurrence_mode).toBe('pinned')
    expect(arg.recurrence_rule.frequency).toBe('weekly')
    expect(arg.recurrence_rule.days).toEqual(['MO', 'WE'])
  })

  it('creates a flex-count routine (N× per period)', async () => {
    const user = userEvent.setup()
    mockCreate.mockResolvedValue({
      id: 'p2', name: 'Gym', category: 'health', recurrence_mode: 'flex_count',
      recurrence_rule: null, active: true, flex_period: 'week', flex_target: 3,
      preferred_time_of_day: 'anytime', dtstart: '2026-06-15',
    })
    render(<ProfileRoutines />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /add routine/i }))
    await user.type(screen.getByLabelText(/^name/i), 'Gym')
    await user.click(screen.getByRole('button', { name: /per period/i }))
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    const arg = mockCreate.mock.calls[0][0] as { recurrence_mode: string; flex_period: string; flex_target: number }
    expect(arg.recurrence_mode).toBe('flex_count')
    expect(arg.flex_period).toBe('week')
    expect(arg.flex_target).toBe(3)
  })

  it('blocks add when a weekly routine has no days selected', async () => {
    const user = userEvent.setup()
    render(<ProfileRoutines />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: /add routine/i }))
    await user.type(screen.getByLabelText(/^name/i), 'No days')
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled()
  })
})
