import { describe, it, expect } from 'vitest'
import { tripSummary } from './tripSummary'
import type { ChecklistRow } from '../lib/dbClient/types'

const cl = (done: number, total: number): ChecklistRow =>
  ({ id: 'x', title: 't', done, total } as ChecklistRow)

describe('tripSummary', () => {
  it('events only, pluralised', () => {
    expect(tripSummary(4, [])).toBe('4 events')
    expect(tripSummary(1, [])).toBe('1 event')
  })

  it('single checklist shows done/total', () => {
    expect(tripSummary(0, [cl(2, 10)])).toBe('checklist 2/10')
  })

  it('events plus one checklist joined with a dot', () => {
    expect(tripSummary(4, [cl(2, 10)])).toBe('4 events · checklist 2/10')
  })

  it('multiple checklists show the count', () => {
    expect(tripSummary(3, [cl(0, 5), cl(1, 2)])).toBe('3 events · 2 checklists')
  })

  it('nothing at all reads as Empty', () => {
    expect(tripSummary(0, [])).toBe('Empty')
  })

  it('tolerates missing done/total counts', () => {
    expect(tripSummary(0, [{ id: 'x', title: 't' } as ChecklistRow])).toBe('checklist 0/0')
  })
})
