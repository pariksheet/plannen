import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileSources } from './ProfileSources'

const mockList = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../lib/dbClient', () => ({
  dbClient: {
    sources: {
      list: (...a: unknown[]) => mockList(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}))

function source(id: string, domain: string, name: string, tags: string[]) {
  return { id, user_id: 'u1', domain, source_url: `https://${domain}/x`, name, tags, source_type: 'venue' }
}

beforeEach(() => vi.clearAllMocks())

async function expand() {
  const user = userEvent.setup()
  render(<ProfileSources />)
  await user.click(screen.getByRole('button', { name: /my sources/i }))
  await waitFor(() => expect(mockList).toHaveBeenCalled())
  return user
}

describe('ProfileSources', () => {
  it('filters the list by the search query', async () => {
    mockList.mockResolvedValue([
      source('s1', 'pool.example', 'City Pool', ['swimming']),
      source('s2', 'climb.example', 'Boulder Hall', ['climbing']),
    ])
    const user = await expand()
    expect(screen.getByText('City Pool')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/search sources/i), 'climb')
    expect(screen.queryByText('City Pool')).toBeNull()
    expect(screen.getByText('Boulder Hall')).toBeInTheDocument()
  })

  it('edits tags via the update service', async () => {
    mockList.mockResolvedValue([source('s1', 'pool.example', 'City Pool', ['swimming'])])
    mockUpdate.mockResolvedValue(source('s1', 'pool.example', 'City Pool', ['swimming', 'kids']))
    const user = await expand()

    await user.click(screen.getByRole('button', { name: /edit tags for city pool/i }))
    const input = screen.getByLabelText(/^tags$/i)
    await user.clear(input)
    await user.type(input, 'swimming, kids')
    await user.click(screen.getByRole('button', { name: /save tags/i }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [id, patch] = mockUpdate.mock.calls[0] as [string, { tags: string[] }]
    expect(id).toBe('s1')
    expect(patch.tags).toEqual(['swimming', 'kids'])
  })
})
