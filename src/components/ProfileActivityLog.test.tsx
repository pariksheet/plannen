import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileActivityLog } from './ProfileActivityLog'

const mockList = vi.fn()
const mockLog = vi.fn()
const mockDelete = vi.fn()
const mockFamily = vi.fn()

vi.mock('../services/activityLogService', () => ({
  listActivityLogs: (...a: unknown[]) => mockList(...a),
  logActivity: (...a: unknown[]) => mockLog(...a),
  deleteActivityLog: (...a: unknown[]) => mockDelete(...a),
}))
vi.mock('../services/profileService', () => ({
  getFamilyMembers: (...a: unknown[]) => mockFamily(...a),
}))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue({ data: [], error: null })
  mockFamily.mockResolvedValue({ data: [], error: null })
})

async function expand() {
  const user = userEvent.setup()
  render(<ProfileActivityLog />)
  await user.click(screen.getByRole('button', { name: /activity log/i }))
  await waitFor(() => expect(mockList).toHaveBeenCalled())
  return user
}

describe('ProfileActivityLog', () => {
  it('logs a duration-based activity', async () => {
    mockLog.mockResolvedValue({ data: { id: 'a1', activity: 'Run', occurred_at: '2026-06-15T08:00:00Z', duration_minutes: 40, quantity: null, unit: null, notes: null, family_member_id: null, tags: [] }, error: null })
    const user = await expand()

    await user.click(screen.getByRole('button', { name: /log activity/i }))
    await user.type(screen.getByLabelText(/^activity$/i), 'Run')
    await user.type(screen.getByLabelText(/duration minutes/i), '40')
    await user.click(screen.getByRole('button', { name: /log it/i }))

    await waitFor(() => expect(mockLog).toHaveBeenCalled())
    const arg = mockLog.mock.calls[0][0] as { activity: string; duration_minutes: number | null }
    expect(arg.activity).toBe('Run')
    expect(arg.duration_minutes).toBe(40)
    expect(await screen.findByText('Run')).toBeInTheDocument()
  })

  it('deletes a logged activity', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'a1', activity: 'Swim', occurred_at: '2026-06-15T08:00:00Z', duration_minutes: 30, quantity: null, unit: null, notes: null, family_member_id: null, tags: [] }], error: null })
    mockDelete.mockResolvedValue({ error: null })
    const user = await expand()
    expect(screen.getByText('Swim')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /delete swim/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('a1'))
    expect(screen.queryByText('Swim')).toBeNull()
  })
})
