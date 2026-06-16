import { describe, it, expect, vi, beforeEach } from 'vitest'

const { create, setItemChecked } = vi.hoisted(() => ({
  create: vi.fn(async (i: unknown) => ({ id: 'c1', items: [], ...(i as object) })),
  setItemChecked: vi.fn(async (id: string, checked: boolean) => ({ id, checked_at: checked ? 'now' : null })),
}))
vi.mock('../lib/dbClient', () => ({ dbClient: { checklists: { create, setItemChecked } } }))

import { createChecklist, setChecklistItemChecked } from './checklistService'

beforeEach(() => { create.mockClear(); setItemChecked.mockClear() })

describe('checklistService', () => {
  it('createChecklist forwards title + items', async () => {
    await createChecklist({ title: 'Packing', items: ['socks'] })
    expect(create).toHaveBeenCalledWith({ title: 'Packing', items: ['socks'] })
  })
  it('setChecklistItemChecked passes the checked flag', async () => {
    await setChecklistItemChecked('i1', true)
    expect(setItemChecked).toHaveBeenCalledWith('i1', true)
  })
})
