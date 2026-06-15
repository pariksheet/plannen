import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IgnoreRulesManager } from './IgnoreRulesManager'

const mockList = vi.fn()
const mockDelete = vi.fn()

vi.mock('../lib/dbClient', () => ({
  dbClient: {
    ignoreRules: {
      list: (...a: unknown[]) => mockList(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

function rule(id: string, pattern: string) {
  return { id, user_id: 'u1', adapter_id: 'gmail', kind: 'sender', pattern, subject_keyword: null, source_event_id: null, source_message_id: null, reason: null, hit_count: 2, last_hit_at: null, created_at: '' }
}

describe('IgnoreRulesManager', () => {
  it('lists rules on expand and deletes one', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([rule('r1', 'noreply@school.example'), rule('r2', 'news@club.example')])
    mockDelete.mockResolvedValue(undefined)
    render(<IgnoreRulesManager />)

    // Collapsed by default — expand.
    await user.click(screen.getByRole('button', { name: /muted senders/i }))
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(screen.getByText('noreply@school.example')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /delete mute rule for noreply@school.example/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('r1'))
    expect(screen.queryByText('noreply@school.example')).toBeNull()
  })

  it('shows an empty state when there are no rules', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([])
    render(<IgnoreRulesManager />)
    await user.click(screen.getByRole('button', { name: /muted senders/i }))
    expect(await screen.findByText(/no muted senders/i)).toBeInTheDocument()
  })
})
