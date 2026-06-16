import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MyGroups } from './MyGroups'

// Tier 1+ so the group-context / pill machinery is active.
vi.mock('../lib/tier', () => ({ TIER: '1' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ profile: { primary_group_id: 'g-primary' } })),
}))
// No shared events → the component renders its empty state but the view toggle
// (the thing under test) still renders in the header, and the supabase
// event-group context query is skipped (eventIds.length === 0 early-returns).
vi.mock('../services/viewService', () => ({
  getGroupsEvents: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/rsvpService', () => ({
  getPreferredVisitDates: vi.fn(async () => ({ data: {} })),
}))
vi.mock('../services/groupService', () => ({
  getMyGroups: vi.fn(async () => ({
    data: [
      { id: 'g-primary', name: 'My Family' },
      { id: 'g-other', name: 'Cycling Club' },
    ],
  })),
}))
vi.mock('../services/eventService', () => ({
  deleteEvent: vi.fn(async () => ({ error: null })),
}))
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(),
  },
}))
vi.mock('./ScheduleOverview', () => ({ ScheduleOverview: () => <div data-testid="schedule-overview" /> }))
vi.mock('./Timeline', () => ({ Timeline: () => <div data-testid="timeline" /> }))
vi.mock('./CalendarGrid', () => ({ CalendarGrid: () => <div data-testid="calendar-grid" /> }))
vi.mock('./EventForm', () => ({ EventForm: () => null }))
vi.mock('./ManageGroups', () => ({ ManageGroups: () => null }))

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/dashboard?view=groups${search}`]}>
      <MyGroups />
    </MemoryRouter>
  )
}

describe('MyGroups view toggle', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('offers a Schedule toggle, defaulted on, for the starred (primary) group', async () => {
    renderAt('&group_id=g-primary')
    const schedule = await screen.findByRole('button', { name: 'Schedule' })
    // Defaults to Schedule when the starred group is opened.
    expect(schedule.className).toContain('bg-indigo-600')
    expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument()
  })

  it('never persists the schedule mode to the shared localStorage key', async () => {
    renderAt('&group_id=g-primary')
    await screen.findByRole('button', { name: 'Schedule' })
    expect(window.localStorage.getItem('timelineViewMode')).not.toBe('schedule')
  })

  it('hides the Schedule toggle for a non-primary group', async () => {
    renderAt('&group_id=g-other')
    // Wait for the pills/groups to load so the toggle has settled.
    await screen.findByRole('button', { name: 'Compact' })
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()
  })

  it('hides the Schedule toggle for the "All" view', async () => {
    renderAt('')
    await screen.findByRole('button', { name: 'Compact' })
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()
  })
})
