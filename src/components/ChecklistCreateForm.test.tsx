import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChecklistCreateForm } from './ChecklistCreateForm'
import type { Event } from '../types/event'

function ev(id: string, title: string): Event {
  return { id, title, start_date: '2026-07-01T00:00:00', end_date: null, event_kind: 'event' } as Event
}

describe('ChecklistCreateForm', () => {
  it('adds items as checkbox rows and creates the checklist attached to a searched event', async () => {
    const onCreate = vi.fn(async () => {})
    render(
      <ChecklistCreateForm
        events={[ev('e1', 'Canada Trip'), ev('e2', 'Dentist')]}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    )
    await userEvent.type(screen.getByPlaceholderText('e.g. Packing'), 'Packing')
    await userEvent.type(screen.getByPlaceholderText('Search your events…'), 'canada')
    await userEvent.click(screen.getByText('Canada Trip'))
    // Each item is added as its own checkbox row (Enter or the Add button).
    await userEvent.type(screen.getByPlaceholderText('Add an item…'), 'socks{enter}')
    await userEvent.type(screen.getByPlaceholderText('Add an item…'), 'sunscreen{enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith({
      title: 'Packing',
      event_id: 'e1',
      items: [{ text: 'socks', checked: false }, { text: 'sunscreen', checked: false }],
    })
  })

  it('lets an item be pre-checked as already done', async () => {
    const onCreate = vi.fn(async () => {})
    render(<ChecklistCreateForm events={[]} onCreate={onCreate} onClose={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('e.g. Packing'), 'Packing')
    await userEvent.type(screen.getByPlaceholderText('Add an item…'), 'passport{enter}')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Check passport' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith({
      title: 'Packing',
      event_id: null,
      items: [{ text: 'passport', checked: true }],
    })
  })

  it('creates a standalone checklist when no event is picked', async () => {
    const onCreate = vi.fn(async () => {})
    render(<ChecklistCreateForm events={[ev('e1', 'Canada Trip')]} onCreate={onCreate} onClose={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('e.g. Packing'), 'Shopping')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith({ title: 'Shopping', event_id: null, items: [] })
  })

  it('disables Create until a title is entered', () => {
    render(<ChecklistCreateForm events={[]} onCreate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})
