import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Event } from '../../src/types/event'
import { EventCard } from '../../src/components/EventCard'

// --- mocks ---------------------------------------------------------------

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../src/services/rsvpService', () => ({
  getMyRsvp: vi.fn(() => Promise.resolve({ data: null, error: null })),
  getRsvpList: vi.fn(() => Promise.resolve({ data: { going: [], maybe: [], not_going: [] }, error: null })),
  getPreferredVisitDateForUser: vi.fn(() => Promise.resolve({ data: null, error: null })),
  getPreferredVisitDates: vi.fn(() => Promise.resolve({ data: [], error: null })),
  getCreatorPreferredVisitDates: vi.fn(() => Promise.resolve({ data: [], error: null })),
  setRsvp: vi.fn(() => Promise.resolve({ error: null })),
  setPreferredVisitDate: vi.fn(() => Promise.resolve({ error: null })),
}))

vi.mock('../../src/services/eventService', () => ({
  getEvent: vi.fn(() => Promise.resolve({ data: null, error: null })),
}))

vi.mock('../../src/services/agentTaskService', () => ({
  getEventWatchTask: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../src/services/calendarExport', () => ({
  downloadIcs: vi.fn(),
  getGoogleCalendarAddUrl: vi.fn(() => 'https://calendar.google.com/test'),
  getOutlookCalendarAddUrl: vi.fn(() => 'https://outlook.live.com/test'),
}))

vi.mock('../../src/utils/whatsappShare', () => ({
  getWhatsAppShareUrl: vi.fn(() => 'https://wa.me/test'),
}))

// Modals are imported unconditionally by EventCard but never opened in these tests.
vi.mock('../../src/components/EventDetailsModal', () => ({
  EventDetailsModal: () => null,
}))
vi.mock('../../src/components/EventShareModal', () => ({
  EventShareModal: () => null,
}))
vi.mock('../../src/components/EventInviteModal', () => ({
  EventInviteModal: () => null,
}))

import { useAuth } from '../../src/context/AuthContext'
const mockedUseAuth = vi.mocked(useAuth)

// --- helpers -------------------------------------------------------------

const ORG_ID = 'org-uuid'
const OTHER_ID = 'other-uuid'

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    created_by: ORG_ID,
    title: 'Niheet swimming',
    description: null,
    start_date: '2026-05-09T10:00:00',
    end_date: '2026-05-09T11:00:00',
    location: 'Mechelen',
    event_kind: 'session',
    event_type: 'family',
    event_status: 'going',
    hashtags: [],
    enrollment_url: null,
    enrollment_deadline: null,
    enrollment_start_date: null,
    image_url: null,
    parent_event_id: null,
    parent_title: null,
    shared_with_family: false,
    shared_with_friends: 'none',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    my_rsvp_status: null,
    ...overrides,
  } as Event
}

function asOrganizer() {
  mockedUseAuth.mockReturnValue({ user: { id: ORG_ID } } as ReturnType<typeof useAuth>)
}

function asNonOrganizer() {
  mockedUseAuth.mockReturnValue({ user: { id: OTHER_ID } } as ReturnType<typeof useAuth>)
}

// --- tests ---------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EventCard compact', () => {
  it('renders the event title in compact mode', () => {
    asOrganizer()
    render(<EventCard event={makeEvent()} viewMode="compact" />)
    expect(screen.getByText('Niheet swimming')).toBeInTheDocument()
  })

  it('shows an inline Invite button for organizer when showActions=true', () => {
    asOrganizer()
    render(
      <EventCard
        event={makeEvent()}
        viewMode="compact"
        showActions
      />
    )
    expect(screen.getByRole('button', { name: /invite/i })).toBeInTheDocument()
  })

  it('shows a kebab "More actions" button that opens with calendar items + Clone + Delete for organizer', () => {
    asOrganizer()
    render(
      <EventCard
        event={makeEvent()}
        viewMode="compact"
        showActions
        onClone={() => {}}
        onDelete={() => {}}
      />
    )
    const kebab = screen.getByRole('button', { name: /more actions/i })
    expect(kebab).toBeInTheDocument()
    fireEvent.click(kebab)

    expect(screen.getByText(/Download \.ics/i)).toBeInTheDocument()
    expect(screen.getByText(/Google Calendar/i)).toBeInTheDocument()
    expect(screen.getByText(/Outlook/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('omits Delete from the kebab for non-organizer and still includes Calendar+Clone', () => {
    asNonOrganizer()
    render(
      <EventCard
        event={makeEvent()}
        viewMode="compact"
        showActions
        onClone={() => {}}
        onDelete={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }))
    expect(screen.getByText(/Download \.ics/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })

  it('hides the kebab when it would render zero items', () => {
    asNonOrganizer()
    render(
      <EventCard
        event={makeEvent({ event_kind: 'reminder' })}
        viewMode="compact"
        showActions
      />
    )
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument()
  })

  it('renders the kebab when at least one item is available (org with onDelete only, reminder)', () => {
    asOrganizer()
    render(
      <EventCard
        event={makeEvent({ event_kind: 'reminder' })}
        viewMode="compact"
        showActions
        onDelete={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument()
  })

  it('does not render an inline Calendar button on the compact card', () => {
    asOrganizer()
    render(
      <EventCard
        event={makeEvent()}
        viewMode="compact"
        showActions
        onClone={() => {}}
        onDelete={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /^add to calendar$/i })).not.toBeInTheDocument()
  })
})
