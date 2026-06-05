import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Event } from '../../src/types/event'

// Mock the data services. We exercise the loadEvents auto-expand path, not
// the timeline/calendar rendering, so we stub the heavy child components.
vi.mock('../../src/services/viewService', () => ({
  getMyFeedEvents: vi.fn(),
}))
vi.mock('../../src/services/rsvpService', () => ({
  getPreferredVisitDates: vi.fn(),
}))
vi.mock('../../src/services/eventService', () => ({
  deleteEvent: vi.fn(),
}))
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-user', email: 't@x' }, loading: false }),
}))
vi.mock('../../src/components/Timeline', () => ({
  Timeline: ({ items, emptyMessage }: { items: Array<{ event: Event }>; emptyMessage: string }) =>
    items.length === 0
      ? <div data-testid="timeline-empty">{emptyMessage}</div>
      : <ul data-testid="timeline">{items.map((i) => <li key={i.event.id}>{i.event.title}</li>)}</ul>,
}))
vi.mock('../../src/components/CalendarGrid', () => ({ CalendarGrid: () => null }))
vi.mock('../../src/components/EventForm', () => ({ EventForm: () => null }))
vi.mock('../../src/components/DiscoverButton', () => ({ DiscoverButton: () => null }))
vi.mock('../../src/components/ScheduleOverview', () => ({
  ScheduleOverview: ({ events }: { events: Array<Event> }) =>
    <ul data-testid="schedule-overview">{events.map((e) => <li key={e.id}>{e.title}</li>)}</ul>,
}))

import { MyFeed } from '../../src/components/MyFeed'
import { getMyFeedEvents } from '../../src/services/viewService'
import { getPreferredVisitDates } from '../../src/services/rsvpService'

const mockedGetMyFeedEvents = vi.mocked(getMyFeedEvents)
const mockedGetPreferredVisitDates = vi.mocked(getPreferredVisitDates)

function fakeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    title: 'Summer camp - August 1st week',
    description: null,
    start_date: '2026-08-03T02:30:00+00:00',
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
    created_by: 'test-user',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    shared_with_friends: 'none',
    ...overrides,
  }
}

beforeEach(() => {
  mockedGetMyFeedEvents.mockReset()
  mockedGetPreferredVisitDates.mockReset()
  mockedGetPreferredVisitDates.mockResolvedValue({ data: {}, error: null })
})

describe('MyFeed window auto-expand', () => {
  it('retries unbounded when the windowed fetch returns zero events', async () => {
    const future = [
      fakeEvent({ id: 'a', title: 'Summer camp - August 1st week', start_date: '2026-08-03T02:30:00+00:00' }),
      fakeEvent({ id: 'b', title: 'Summer camp - August 2nd week', start_date: '2026-08-10T03:30:00+00:00' }),
    ]
    mockedGetMyFeedEvents
      .mockResolvedValueOnce({ data: [], error: null })       // windowed
      .mockResolvedValueOnce({ data: future, error: null })   // unbounded retry

    render(<MemoryRouter><MyFeed /></MemoryRouter>)

    await waitFor(() => expect(mockedGetMyFeedEvents).toHaveBeenCalledTimes(2))
    // First call carries a window; second carries no window params.
    const firstArgs = mockedGetMyFeedEvents.mock.calls[0][0]
    const secondArgs = mockedGetMyFeedEvents.mock.calls[1][0]
    expect(firstArgs).toMatchObject({ from_date: expect.any(String), to_date: expect.any(String) })
    expect(secondArgs).toBeUndefined()

    expect(await screen.findByText('Summer camp - August 1st week')).toBeInTheDocument()
    expect(screen.getByText('Summer camp - August 2nd week')).toBeInTheDocument()
    expect(screen.queryByText(/No events yet/i)).not.toBeInTheDocument()
  })

  it('does not retry when the windowed fetch already returns events', async () => {
    mockedGetMyFeedEvents.mockResolvedValueOnce({
      data: [fakeEvent({ id: 'in-window', title: 'In-window event', start_date: '2026-06-01T10:00:00Z' })],
      error: null,
    })

    render(<MemoryRouter><MyFeed /></MemoryRouter>)

    expect(await screen.findByText('In-window event')).toBeInTheDocument()
    // Give the effect time to settle; assert no second call.
    await new Promise((r) => setTimeout(r, 20))
    expect(mockedGetMyFeedEvents).toHaveBeenCalledTimes(1)
  })

  it('still shows the empty state when the user truly has no events', async () => {
    mockedGetMyFeedEvents
      .mockResolvedValueOnce({ data: [], error: null }) // windowed
      .mockResolvedValueOnce({ data: [], error: null }) // unbounded

    render(<MemoryRouter><MyFeed /></MemoryRouter>)

    await waitFor(() => expect(mockedGetMyFeedEvents).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/No events yet\. Create your first event/i)).toBeInTheDocument()
  })
})
