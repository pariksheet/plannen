import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarGrid } from './CalendarGrid'
import { Event } from '../types/event'

// Stub heavy sub-components that pull in services/auth/DB
vi.mock('./EventList', () => ({
  EventList: () => <div data-testid="event-list" />,
}))
vi.mock('./EventDetailsModal', () => ({
  EventDetailsModal: () => <div data-testid="event-details-modal" />,
}))
vi.mock('./EventForm', () => ({
  EventForm: () => <div data-testid="event-form" />,
}))

function makeEvent(id: string, dateIso: string): Event {
  return {
    id,
    title: `Event ${id}`,
    description: null,
    start_date: dateIso,
    end_date: null,
    enrollment_url: null,
    enrollment_deadline: null,
    enrollment_start_date: null,
    image_url: null,
    location: null,
    hashtags: null,
    event_kind: 'event',
    event_type: 'personal',
    event_status: 'going',
    created_by: 'u1',
    created_at: '',
    updated_at: '',
    shared_with_friends: 'none',
    completed_at: null,
    assigned_to: null,
  }
}

describe('CalendarGrid compact dot cap (DOT_CAP = 11)', () => {
  it('renders 7 blue dots for a day with 7 events (below cap)', () => {
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const events = Array.from({ length: 7 }, (_, i) => makeEvent(`e${i}`, iso))

    const { container } = render(
      <CalendarGrid
        events={events}
        preferredVisitDates={{}}
        compact
      />
    )

    const blueDots = container.querySelectorAll('.bg-blue-600')
    expect(blueDots.length).toBe(7)
  })

  it('renders 11 blue dots (not 12) and shows "+" overflow for a day with 12 events', () => {
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const events = Array.from({ length: 12 }, (_, i) => makeEvent(`e${i}`, iso))

    const { container } = render(
      <CalendarGrid
        events={events}
        preferredVisitDates={{}}
        compact
      />
    )

    const blueDots = container.querySelectorAll('.bg-blue-600')
    expect(blueDots.length).toBe(11)

    // The overflow "+" marker must be present
    const allText = container.textContent ?? ''
    expect(allText).toContain('+')
  })
})

describe('CalendarGrid – trip bands', () => {
  it('renders a trip container as a spanning band (not a dot)', () => {
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), 10, 9, 0).toISOString()
    const end = new Date(today.getFullYear(), today.getMonth(), 14, 17, 0).toISOString()
    const trip = { ...makeEvent('trip1', start), title: 'Canada', event_kind: 'container' as const, end_date: end }

    const { container } = render(<CalendarGrid events={[trip]} preferredVisitDates={{}} compact />)

    // The band carries the trip title on every covered day (via title attr).
    expect(screen.getAllByTitle('Canada').length).toBeGreaterThan(0)
    // A container must NOT be counted as a blue event dot.
    expect(container.querySelectorAll('.bg-blue-600').length).toBe(0)
    // The band uses the violet colour.
    expect(container.querySelectorAll('.bg-violet-500').length).toBeGreaterThan(0)
  })
})

describe('CalendarGrid – create from day', () => {
  it('opens the event form when the sidebar Add button is clicked', async () => {
    const user = userEvent.setup()
    render(<CalendarGrid events={[]} preferredVisitDates={{}} />)
    // Empty-day Add affordance (no events selected by default)
    expect(screen.queryByTestId('event-form')).toBeNull()
    await user.click(screen.getByRole('button', { name: /add event on this day/i }))
    expect(screen.getByTestId('event-form')).toBeInTheDocument()
  })
})
