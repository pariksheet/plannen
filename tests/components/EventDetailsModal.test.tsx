import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventDetailsModal } from '../../src/components/EventDetailsModal'
import { Event } from '../../src/types/event'

vi.mock('../../src/services/agentTaskService', () => ({
  getEventWatchTask: vi.fn(async () => null),
  acknowledgeWatchUpdate: vi.fn(async () => {}),
}))
vi.mock('../../src/services/eventService', () => ({
  getEvent: vi.fn(async () => ({ data: null, error: null })),
}))
vi.mock('../../src/lib/dbClient', () => ({
  dbClient: { events: {}, ignoreRules: {} },
}))
vi.mock('../../src/components/RSVPButton', () => ({ RSVPButton: () => null }))
vi.mock('../../src/components/RSVPList', () => ({ RSVPList: () => null }))
vi.mock('../../src/components/PreferredVisitDate', () => ({ PreferredVisitDate: () => null }))
vi.mock('../../src/components/EventMemory', () => ({ EventMemoryComponent: () => null }))
vi.mock('../../src/components/EventStorySection', () => ({ EventStorySection: () => null }))
vi.mock('../../src/components/MuteSyncDialog', () => ({ MuteSyncDialog: () => null }))
vi.mock('../../src/components/SweepMatchesDialog', () => ({ SweepMatchesDialog: () => null }))

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    title: 'Padel night',
    description: null,
    start_date: '2026-06-10T18:00:00',
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
    created_at: '2026-06-01',
    updated_at: '2026-06-01',
    shared_with_friends: 'none',
    ...overrides,
  } as Event
}

describe('EventDetailsModal edit handoff', () => {
  it('shows an Edit button when onEdit is provided; clicking closes and hands off', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onClose = vi.fn()
    const event = makeEvent()
    render(
      <EventDetailsModal
        event={event}
        isOpen
        onClose={onClose}
        onEdit={onEdit}
        showRSVP={false}
        rsvpVersion={0}
        onRsvpVersionChange={() => {}}
      />
    )
    await user.click(screen.getByRole('button', { name: /edit event/i }))
    expect(onClose).toHaveBeenCalled()
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  it('renders no Edit button without onEdit', () => {
    render(
      <EventDetailsModal
        event={makeEvent()}
        isOpen
        onClose={vi.fn()}
        showRSVP={false}
        rsvpVersion={0}
        onRsvpVersionChange={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /edit event/i })).not.toBeInTheDocument()
  })
})
