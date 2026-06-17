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
  it('is just the source name (drop role shown separately as a badge)', () => {
    expect(obligationLabel(ob())).toBe('example school')
  })

  it('is just the source name for a pick', () => {
    expect(obligationLabel(ob({ role: 'pick', source_name: 'summer camp' })))
      .toBe('summer camp')
  })

  it('does not prefix the role or a separator', () => {
    expect(obligationLabel(ob())).not.toMatch(/drop|pick|·/)
  })
})
