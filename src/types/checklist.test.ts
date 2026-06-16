import { describe, it, expect } from 'vitest'
import { checklistProgress } from './checklist'

describe('checklistProgress', () => {
  it('counts checked items', () => {
    expect(checklistProgress([{ checked_at: null }, { checked_at: 'x' }])).toEqual({ done: 1, total: 2 })
  })
  it('is 0/0 when empty', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 })
  })
})
