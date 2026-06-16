import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileFacts } from './ProfileFacts'

const mockListFacts = vi.fn()
const mockUpsertFact = vi.fn()
const mockDeleteFact = vi.fn()

vi.mock('../lib/dbClient', () => ({
  dbClient: {
    profile: {
      listFacts: (...a: unknown[]) => mockListFacts(...a),
      upsertFact: (...a: unknown[]) => mockUpsertFact(...a),
      deleteFact: (...a: unknown[]) => mockDeleteFact(...a),
    },
  },
}))

function fact(id: string, predicate: string, value: string) {
  return { id, user_id: 'u1', subject: 'user', predicate, value, confidence: 1, source: 'user', is_historical: false, last_seen_at: '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

async function expand() {
  const user = userEvent.setup()
  render(<ProfileFacts />)
  await user.click(screen.getByRole('button', { name: /facts claude knows about you/i }))
  await waitFor(() => expect(mockListFacts).toHaveBeenCalled())
  return user
}

describe('ProfileFacts add + correct', () => {
  it('adds a manually-entered fact', async () => {
    mockListFacts.mockResolvedValue([])
    mockUpsertFact.mockResolvedValue(fact('new', 'likes', 'hiking'))
    const user = await expand()

    await user.click(screen.getByRole('button', { name: /add a fact/i }))
    await user.type(screen.getByLabelText(/fact predicate/i), 'likes')
    await user.type(screen.getByLabelText(/fact value/i), 'hiking')
    await user.click(screen.getByRole('button', { name: /^add fact$/i }))

    await waitFor(() => expect(mockUpsertFact).toHaveBeenCalled())
    const arg = mockUpsertFact.mock.calls[0][0] as { predicate: string; value: string; source: string }
    expect(arg.predicate).toBe('likes')
    expect(arg.value).toBe('hiking')
    expect(arg.source).toBe('user')
  })

  it('corrects a fact by replacing it (insert new + delete old)', async () => {
    mockListFacts.mockResolvedValue([fact('f1', 'likes', 'hiking')])
    mockUpsertFact.mockResolvedValue(fact('f2', 'likes', 'cycling'))
    mockDeleteFact.mockResolvedValue(undefined)
    const user = await expand()

    await user.click(screen.getByRole('button', { name: /correct fact/i }))
    const input = screen.getByLabelText(/corrected value/i)
    await user.clear(input)
    await user.type(input, 'cycling')
    await user.click(screen.getByRole('button', { name: /save correction/i }))

    await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'))
    const arg = mockUpsertFact.mock.calls[0][0] as { value: string }
    expect(arg.value).toBe('cycling')
  })
})
