import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChecklistList } from './ChecklistList'
import type { ChecklistRow } from '../lib/dbClient/types'

function makeList(o: Partial<ChecklistRow> = {}): ChecklistRow {
  return { id: 'c1', title: 'Packing', event_id: null, created_by: 'u1', created_at: '', updated_at: '', done: 1, total: 3, ...o }
}

describe('ChecklistList', () => {
  it('renders each list title and its progress', () => {
    render(<ChecklistList checklists={[makeList()]} onOpen={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('Packing')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })
  it('calls onOpen when a list is clicked', () => {
    const onOpen = vi.fn()
    render(<ChecklistList checklists={[makeList()]} onOpen={onOpen} onDelete={vi.fn()} />)
    screen.getByText('Packing').click()
    expect(onOpen).toHaveBeenCalledWith('c1')
  })
  it('shows the empty state with no lists', () => {
    render(<ChecklistList checklists={[]} onOpen={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(/no checklists/i)).toBeInTheDocument()
  })
})
