import { describe, it, expect } from 'vitest'
import { practiceLabel } from './practiceLabel'
import type { PracticeRow } from '../lib/dbClient/types'

const base = {
  id: 'p', user_id: 'u', family_member_id: null, name: 'Meal prep',
  category: 'household' as const, dtstart: '2026-06-01', recurrence_until: null,
  preferred_time_of_day: 'anytime' as const, active: true,
  created_at: '', updated_at: '',
}

describe('practiceLabel', () => {
  it('flex_count week shows done/target', () => {
    const p: PracticeRow = { ...base, name: 'Gym', recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 3 }
    expect(practiceLabel(p, 2)).toBe('Gym (2/3 this week)')
  })
  it('every-N-days shows the interval', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily', interval: 2 }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Meal prep (every 2 days)')
  })
  it('plain daily shows (daily)', () => {
    const p: PracticeRow = { ...base, name: 'Vitamins', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Vitamins (daily)')
  })
  it('weekly shows the days', () => {
    const p: PracticeRow = { ...base, name: 'Walk', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'weekly', days: ['MO', 'WE', 'FR'] }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Walk (Mon/Wed/Fri)')
  })
})
