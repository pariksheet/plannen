import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChecklistItemRow } from './ChecklistItemRow'
import type { ChecklistItemRow as Item } from '../lib/dbClient/types'

function item(o: Partial<Item> = {}): Item {
  return { id: 'i1', checklist_id: 'c1', text: 'socks', checked_at: null, checked_by: null, created_by: null, position: 0, created_at: '', ...o }
}

describe('ChecklistItemRow', () => {
  it('renders the item text', () => {
    render(<ChecklistItemRow item={item()} names={{}} onToggle={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} />)
    expect(screen.getByText('socks')).toBeInTheDocument()
  })

  it('renames an item: pencil → edit → Enter saves the new text', async () => {
    const onRename = vi.fn()
    render(<ChecklistItemRow item={item()} names={{}} onToggle={vi.fn()} onDelete={vi.fn()} onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: /rename item/i }))
    const input = screen.getByDisplayValue('socks')
    await userEvent.clear(input)
    await userEvent.type(input, 'wool socks{enter}')
    expect(onRename).toHaveBeenCalledWith('i1', 'wool socks')
  })

  it('Escape cancels the rename without calling onRename', async () => {
    const onRename = vi.fn()
    render(<ChecklistItemRow item={item()} names={{}} onToggle={vi.fn()} onDelete={vi.fn()} onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: /rename item/i }))
    await userEvent.type(screen.getByDisplayValue('socks'), ' extra{escape}')
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('socks')).toBeInTheDocument()
  })

  it('does not save an empty/whitespace rename', async () => {
    const onRename = vi.fn()
    render(<ChecklistItemRow item={item()} names={{}} onToggle={vi.fn()} onDelete={vi.fn()} onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: /rename item/i }))
    const input = screen.getByDisplayValue('socks')
    await userEvent.clear(input)
    await userEvent.type(input, '   {enter}')
    expect(onRename).not.toHaveBeenCalled()
  })
})
