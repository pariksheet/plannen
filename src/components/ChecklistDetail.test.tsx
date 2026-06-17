import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '../types/event'
import type { ChecklistRow, ChecklistItemRow as ChecklistItem } from '../lib/dbClient/types'

const reattach = vi.fn()
const resetAll = vi.fn()
let mockChecklist: ChecklistRow

vi.mock('../hooks/useChecklist', () => ({
  useChecklist: () => ({
    checklist: mockChecklist, names: {}, reload: vi.fn(), toggle: vi.fn(),
    addItems: vi.fn(), removeItem: vi.fn(), renameItem: vi.fn(), rename: vi.fn(),
    reattach, resetAll,
  }),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))
vi.mock('./ChecklistShareModal', () => ({ ChecklistShareModal: () => <div data-testid="share-modal" /> }))

import { ChecklistDetail } from './ChecklistDetail'

function checkedItem(id: string): ChecklistItem {
  return { id, checklist_id: 'c1', text: id, checked_at: '2026-01-01T00:00:00Z', checked_by: 'u1', position: 0, created_at: '', created_by: 'u1' } as ChecklistItem
}

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

describe('ChecklistDetail reset all', () => {
  beforeEach(() => {
    resetAll.mockClear()
    mockChecklist = { id: 'c1', title: 'Belgium Tax', event_id: null, created_by: 'u1', items: [checkedItem('i1')], created_at: '', updated_at: '' }
  })

  it('opens a confirm modal instead of window.confirm, and resets only on confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /reset all/i }))
    expect(confirmSpy).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(resetAll).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /reset all/i }))
    expect(resetAll).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('cancelling the confirm modal does not reset', async () => {
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /reset all/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(resetAll).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides Reset all when nothing is checked', () => {
    mockChecklist = { ...mockChecklist, items: [] }
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /reset all/i })).toBeNull()
  })
})

describe('ChecklistDetail share', () => {
  beforeEach(() => {
    mockChecklist = { id: 'c1', title: 'Belgium Tax', event_id: null, created_by: 'u1', items: [], created_at: '', updated_at: '' }
  })

  it('shows a Share button for the owner and opens the share modal', async () => {
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    expect(screen.queryByTestId('share-modal')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /share/i }))
    expect(screen.getByTestId('share-modal')).toBeInTheDocument()
  })

  it('hides the Share button for non-owners', () => {
    mockChecklist = { ...mockChecklist, created_by: 'someone-else' }
    render(<ChecklistDetail id="c1" onBack={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
  })
})
