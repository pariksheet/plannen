import { describe, it, expect, vi, beforeEach } from 'vitest'

const { create, setItemChecked, get } = vi.hoisted(() => ({
  // create returns items in insertion order with ids i0, i1, … so the service
  // can line pre-checked drafts up by index.
  create: vi.fn(async (i: { title: string; event_id?: string | null; items?: string[] }) => ({
    id: 'c1',
    items: (i.items ?? []).map((text, idx) => ({ id: `i${idx}`, text, position: idx, checked_at: null, checked_by: null })),
  })),
  setItemChecked: vi.fn(async (id: string, checked: boolean) => ({ id, checked_at: checked ? 'now' : null })),
  get: vi.fn(async (id: string) => ({ id, items: [], refreshed: true })),
}))
vi.mock('../lib/dbClient', () => ({ dbClient: { checklists: { create, setItemChecked, get } } }))

import { createChecklist, setChecklistItemChecked, resetChecklistItems } from './checklistService'
import type { ChecklistItemRow } from '../lib/dbClient/types'

const item = (id: string, checked: boolean): ChecklistItemRow =>
  ({ id, checklist_id: 'c1', text: id, checked_at: checked ? 'now' : null, checked_by: null, created_by: null, position: 0, created_at: 'now' })

beforeEach(() => { create.mockClear(); setItemChecked.mockClear(); get.mockClear() })

describe('checklistService', () => {
  it('createChecklist forwards title + plain item texts to the data layer', async () => {
    await createChecklist({ title: 'Packing', items: [{ text: 'socks' }, { text: 'sunscreen' }] })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Packing', items: ['socks', 'sunscreen'] }))
  })

  it('drops empty-text items before creating', async () => {
    await createChecklist({ title: 'Packing', items: [{ text: 'socks' }, { text: '  ' }] })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ items: ['socks'] }))
  })

  it('persists pre-checked items via setItemChecked, then refetches', async () => {
    const result = await createChecklist({ title: 'Packing', items: [{ text: 'a', checked: false }, { text: 'b', checked: true }] })
    // Only the second (index 1, id i1) item was pre-checked.
    expect(setItemChecked).toHaveBeenCalledTimes(1)
    expect(setItemChecked).toHaveBeenCalledWith('i1', true)
    expect(get).toHaveBeenCalledWith('c1')
    expect(result).toMatchObject({ refreshed: true })
  })

  it('skips the toggle + refetch when nothing is pre-checked', async () => {
    await createChecklist({ title: 'Packing', items: [{ text: 'a' }, { text: 'b' }] })
    expect(setItemChecked).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('setChecklistItemChecked passes the checked flag', async () => {
    await setChecklistItemChecked('i1', true)
    expect(setItemChecked).toHaveBeenCalledWith('i1', true)
  })

  it('resetChecklistItems unchecks only the checked items', async () => {
    await resetChecklistItems([item('a', true), item('b', false), item('c', true)])
    expect(setItemChecked).toHaveBeenCalledTimes(2)
    expect(setItemChecked).toHaveBeenCalledWith('a', false)
    expect(setItemChecked).toHaveBeenCalledWith('c', false)
    expect(setItemChecked).not.toHaveBeenCalledWith('b', false)
  })
})
