import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MyStories } from '../../src/components/MyStories'

vi.mock('../../src/hooks/useStories', () => ({
  useStories: vi.fn(),
}))

import { useStories } from '../../src/hooks/useStories'
const mockedUseStories = vi.mocked(useStories)

beforeEach(() => { mockedUseStories.mockReset() })

describe('MyStories', () => {
  it('shows the empty state when there are no stories', () => {
    mockedUseStories.mockReturnValue({ stories: [], loading: false, error: null, refresh: vi.fn() })
    render(<MemoryRouter><MyStories /></MemoryRouter>)
    expect(screen.getByText(/No stories yet/i)).toBeInTheDocument()
  })

  it('renders a hero + grid when there are multiple stories', () => {
    mockedUseStories.mockReturnValue({
      stories: [
        {
          id: 's1', user_id: 'u', story_group_id: 'g1', language: 'en',
          title: 'Hero story', body: 'Opening sentence of the hero.',
          cover_url: null, user_notes: null, mood: null, tone: null,
          date_from: null, date_to: null,
          generated_at: '2026-05-07T10:00:00Z', edited_at: null,
          created_at: '2026-05-07T10:00:00Z', updated_at: '2026-05-07T10:00:00Z',
          events: [{ id: 'e1', title: 'Brussels Motor Show', start_date: '2026-01-14T09:00:00Z' }],
        },
        {
          id: 's2', user_id: 'u', story_group_id: 'g2', language: 'en',
          title: 'Grid story', body: 'Another body.',
          cover_url: null, user_notes: null, mood: null, tone: null,
          date_from: null, date_to: null,
          generated_at: '2026-04-01T10:00:00Z', edited_at: null,
          created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-01T10:00:00Z',
          events: [{ id: 'e2', title: 'Pool day', start_date: '2026-03-01T09:00:00Z' }],
        },
      ],
      loading: false, error: null, refresh: vi.fn(),
    })
    render(<MemoryRouter><MyStories /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Hero story' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Grid story' })).toBeInTheDocument()
    expect(screen.getByText(/Brussels Motor Show/)).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    mockedUseStories.mockReturnValue({ stories: [], loading: true, error: null, refresh: vi.fn() })
    render(<MemoryRouter><MyStories /></MemoryRouter>)
    expect(screen.getByText(/Loading…/)).toBeInTheDocument()
  })

  it('renders cards as links to /stories/:id', () => {
    mockedUseStories.mockReturnValue({
      stories: [
        {
          id: 's1', user_id: 'u', story_group_id: 'g1', language: 'en',
          title: 'Hero story', body: 'Body.',
          cover_url: null, user_notes: null, mood: null, tone: null,
          date_from: null, date_to: null,
          generated_at: '2026-05-07T10:00:00Z', edited_at: null,
          created_at: '2026-05-07T10:00:00Z', updated_at: '2026-05-07T10:00:00Z',
          events: [{ id: 'e1', title: 'Brussels Motor Show', start_date: '2026-01-14T09:00:00Z' }],
        },
      ],
      loading: false, error: null, refresh: vi.fn(),
    })
    render(<MemoryRouter><MyStories /></MemoryRouter>)
    const link = screen.getByRole('link', { name: /Hero story/i })
    expect(link).toHaveAttribute('href', '/stories/s1')
  })

  it('renders an error message when the hook reports an error', () => {
    mockedUseStories.mockReturnValue({
      stories: [], loading: false,
      error: new Error('boom'),
      refresh: vi.fn(),
    })
    render(<MemoryRouter><MyStories /></MemoryRouter>)
    expect(screen.getByText(/boom/)).toBeInTheDocument()
  })
})
