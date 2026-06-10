import { describe, it, expect } from 'vitest'
import { obligationLabel } from './obligationLabel'
import type { ResolvedObligationRow } from '../lib/dbClient/types'

function ob(overrides: Partial<ResolvedObligationRow> = {}): ResolvedObligationRow {
  return {
    obligation_id: 'o1',
    role: 'drop',
    date: '2026-06-10',
    time: '08:15',
    location_id: null,
    source_attendance_id: 'a1',
    source_name: 'example school',
    ...overrides,
  }
}

describe('obligationLabel', () => {
  it('labels a drop with its source name', () => {
    expect(obligationLabel(ob())).toBe('drop · example school')
  })

  it('labels a pick with its source name', () => {
    expect(obligationLabel(ob({ role: 'pick', source_name: 'summer camp' })))
      .toBe('pick · summer camp')
  })

  it('uses a middot separator', () => {
    expect(obligationLabel(ob())).toContain('·')
  })
})
