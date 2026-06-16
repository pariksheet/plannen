import { describe, it, expect } from 'vitest'
import { nextPosition, checklistProgress, ACCESSIBLE_CHECKLIST_SQL } from './checklists.js'

describe('nextPosition', () => {
  it('is 0 for an empty list', () => {
    expect(nextPosition([])).toBe(0)
  })
  it('is max(position)+1 otherwise', () => {
    expect(nextPosition([{ position: 0 }, { position: 4 }, { position: 2 }])).toBe(5)
  })
})

describe('checklistProgress', () => {
  it('counts checked vs total', () => {
    expect(checklistProgress([
      { checked_at: null }, { checked_at: '2026-06-16T10:00:00Z' }, { checked_at: null },
    ])).toEqual({ done: 1, total: 3 })
  })
  it('is 0/0 for an empty list', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('ACCESSIBLE_CHECKLIST_SQL', () => {
  it('references the owner column and both sharing tables', () => {
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('created_by')
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('checklist_shared_with_users')
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('checklist_shared_with_groups')
  })
})
