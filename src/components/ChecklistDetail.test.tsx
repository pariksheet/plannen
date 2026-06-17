import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '../types/event'
import type { ChecklistRow } from '../lib/dbClient/types'

const reattach = vi.fn()
let mockChecklist: ChecklistRow

vi.mock('../hooks/useChecklist', () => ({
  useChecklist: () => ({
    checklist: mockChecklist, names: {}, reload: vi.fn(), toggle: vi.fn(),
    addItems: vi.fn(), removeItem: vi.fn(), renameItem: vi.fn(), rename: vi.fn(),
    reattach, resetAll: vi.fn(),
  }),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { ChecklistDetail } from './ChecklistDetail'

function ev(id: string, title: string, extra: Partial<Event> = {}): Event {
  return { id, title, start_date: '2026-07-01T00:00:00', end_date: null, event_kind: 'event', ...extra } as Event
}

describe('ChecklistDetail reattach', () => {
  beforeEach(() => {
    reattach.mockClear()
    mockChecklist = { id: 'c1', title: 'Belgium Tax', event_id: 'e-cancel', created_by: 'u1', items: [], created_at: '', updated_at: '' }
  })

  it('reattaches to a chosen event, hiding cancelled events from the picker', async () => {
    const events = [ev('e-go', 'Tax return', { event_status: 'going' }), ev('e-cancel', 'Tax return', { event_status: 'cancelled' })]
    render(<ChecklistDetail id="c1" onBack={vi.fn()} events={events} />)
    await userEvent.click(screen.getByRole('button', { name: /change attached event/i }))
    await userEvent.type(screen.getByLabelText('Search events to attach'), 'tax')
    // Two events share the title, but the cancelled one is not offered.
    expect(screen.getAllByText('Tax return')).toHaveLength(1)
    await userEvent.click(screen.getByText('Tax return'))
    expect(reattach).toHaveBeenCalledWith('e-go')
  })

  it('detaches when "Detach from event" is chosen', async () => {
    render(<ChecklistDetail id="c1" onBack={vi.fn()} events={[ev('e-go', 'Trip', { event_status: 'going' })]} />)
    await userEvent.click(screen.getByRole('button', { name: /change attached event/i }))
    await userEvent.click(screen.getByText('Detach from event'))
    expect(reattach).toHaveBeenCalledWith(null)
  })

  it('hides the reattach control when no events are provided', () => {
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /change attached event/i })).toBeNull()
  })
})
