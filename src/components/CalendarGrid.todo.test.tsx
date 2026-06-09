import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
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

function todoOn(dateIso: string): Event {
  return {
    id: 't1', title: 'Pay invoice', description: null,
    start_date: dateIso, end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'todo', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
    completed_at: null, assigned_to: 'u1',
  }
}

describe('CalendarGrid todo dot', () => {
  it('renders an amber todo dot for a day with a todo (compact)', () => {
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const { container } = render(
      <CalendarGrid
        events={[todoOn(iso)]}
        preferredVisitDates={{}}
        compact
      />
    )
    expect(container.querySelector('.bg-amber-500')).not.toBeNull()
  })

  it('does NOT render a blue dot for a todo in compact mode (todos leave blue bucket)', () => {
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const { container } = render(
      <CalendarGrid
        events={[todoOn(iso)]}
        preferredVisitDates={{}}
        compact
      />
    )
    // Only reminder dots (green) and todo dots (amber) — no blue event dots
    expect(container.querySelector('.bg-blue-600')).toBeNull()
  })

  it('renders an amber dot in non-compact mode', () => {
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const { container } = render(
      <CalendarGrid
        events={[todoOn(iso)]}
        preferredVisitDates={{}}
      />
    )
    expect(container.querySelector('.bg-amber-500')).not.toBeNull()
  })
})
