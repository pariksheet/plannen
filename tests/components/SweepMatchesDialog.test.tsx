import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SweepMatchesDialog } from '../../src/components/SweepMatchesDialog'

const matches = [
  { id: 'a', title: 'ACME Renewal 1', start_date: '2026-04-01T10:00:00Z' },
  { id: 'b', title: 'ACME Renewal 2', start_date: '2026-03-01T10:00:00Z' },
  { id: 'c', title: 'ACME KYC',       start_date: '2026-02-01T10:00:00Z' },
]

describe('SweepMatchesDialog', () => {
  it('renders all matches as default-checked checkboxes', () => {
    render(<SweepMatchesDialog isOpen matches={matches} onClose={() => {}} onDelete={vi.fn()} />)
    const cbs = screen.getAllByRole('checkbox')
    expect(cbs).toHaveLength(3)
    cbs.forEach((cb) => expect((cb as HTMLInputElement).checked).toBe(true))
  })

  it('Delete selected fires onDelete with checked ids only', () => {
    const onDelete = vi.fn()
    render(<SweepMatchesDialog isOpen matches={matches} onClose={() => {}} onDelete={onDelete} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    expect(onDelete).toHaveBeenCalledWith(['a', 'c'])
  })

  it('Keep all calls onClose without onDelete', () => {
    const onDelete = vi.fn()
    const onClose = vi.fn()
    render(<SweepMatchesDialog isOpen matches={matches} onClose={onClose} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: /keep all/i }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
