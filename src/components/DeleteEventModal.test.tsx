import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '../types/event'

const { deleteEvent, deleteEventSeries } = vi.hoisted(() => ({
  deleteEvent: vi.fn(async () => ({ error: null as Error | null })),
  deleteEventSeries: vi.fn(async () => ({ error: null as Error | null })),
}))
vi.mock('../services/eventService', () => ({ deleteEvent, deleteEventSeries }))

import { DeleteEventModal } from './DeleteEventModal'

function ev(extra: Partial<Event> = {}): Event {
  return {
    id: 'e1', title: 'Swim', description: null, start_date: '2026-07-01T00:00:00', end_date: null,
    event_kind: 'event', event_type: 'personal', event_status: 'going', created_by: 'u1', created_at: '', updated_at: '',
    ...extra,
  } as Event
}

beforeEach(() => {
  deleteEvent.mockClear(); deleteEvent.mockResolvedValue({ error: null })
  deleteEventSeries.mockClear(); deleteEventSeries.mockResolvedValue({ error: null })
})

describe('DeleteEventModal', () => {
  it('renders nothing when no event is given', () => {
    const { container } = render(<DeleteEventModal event={null} onClose={vi.fn()} onDeleted={vi.fn()} onError={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('a plain event shows a single Delete that removes just it', async () => {
    const onDeleted = vi.fn()
    render(<DeleteEventModal event={ev()} onClose={vi.fn()} onDeleted={onDeleted} onError={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /delete series/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(deleteEvent).toHaveBeenCalledWith('e1')
    expect(deleteEventSeries).not.toHaveBeenCalled()
    expect(onDeleted).toHaveBeenCalled()
  })

  it('a child session offers "Delete this event" (single) and "Delete series"', async () => {
    render(<DeleteEventModal event={ev({ parent_event_id: 'master-1' })} onClose={vi.fn()} onDeleted={vi.fn()} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /delete this event/i }))
    expect(deleteEvent).toHaveBeenCalledWith('e1')
    expect(deleteEventSeries).not.toHaveBeenCalled()
  })

  it('deleting the series from a child session targets the master', async () => {
    render(<DeleteEventModal event={ev({ parent_event_id: 'master-1' })} onClose={vi.fn()} onDeleted={vi.fn()} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /delete series/i }))
    expect(deleteEventSeries).toHaveBeenCalledWith('master-1')
    expect(deleteEvent).not.toHaveBeenCalled()
  })

  it('a recurrence master only offers series delete, targeting itself', async () => {
    render(<DeleteEventModal event={ev({ recurrence_rule: { frequency: 'weekly' } })} onClose={vi.fn()} onDeleted={vi.fn()} onError={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /delete this event/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /delete series/i }))
    expect(deleteEventSeries).toHaveBeenCalledWith('e1')
  })

  it('reports the error and keeps the modal open when a delete fails', async () => {
    deleteEvent.mockResolvedValueOnce({ error: new Error('nope') })
    const onError = vi.fn(); const onClose = vi.fn(); const onDeleted = vi.fn()
    render(<DeleteEventModal event={ev()} onClose={onClose} onDeleted={onDeleted} onError={onError} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onError).toHaveBeenCalledWith('nope')
    expect(onClose).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
