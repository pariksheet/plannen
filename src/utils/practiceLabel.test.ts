import { describe, it, expect } from 'vitest'
import { practiceLabel, monthStartIso, practicePeriodStart, doneThisPeriod } from './practiceLabel'
import type { PracticeRow } from '../lib/dbClient/types'

const base = {
  id: 'p', user_id: 'u', family_member_id: null, name: 'Meal prep',
  category: 'household' as const, dtstart: '2026-06-01', recurrence_until: null,
  preferred_time_of_day: 'anytime' as const, precise_time: null as string | null,
  active: true, created_at: '', updated_at: '',
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

describe('monthStartIso', () => {
  it('returns the 1st of the calendar month', () => {
    expect(monthStartIso('2026-06-17')).toBe('2026-06-01')
  })
})

describe('practicePeriodStart', () => {
  it('uses month-start for a flex_count month practice', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'month', flex_target: 4 }
    expect(practicePeriodStart(p, '2026-06-15', '2026-06-17')).toBe('2026-06-01')
  })
  it('uses the week-start for a flex_count week practice', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 3 }
    expect(practicePeriodStart(p, '2026-06-15', '2026-06-17')).toBe('2026-06-15')
  })
  it('uses the week-start for a pinned practice', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(practicePeriodStart(p, '2026-06-15', '2026-06-17')).toBe('2026-06-15')
  })
})

describe('doneThisPeriod', () => {
  const weekP: PracticeRow = { ...base, id: 'p', name: 'Gym', recurrence_mode: 'flex_count',
    recurrence_rule: null, flex_period: 'week', flex_target: 3 }
  const monthP: PracticeRow = { ...base, id: 'p', name: 'Deep clean', recurrence_mode: 'flex_count',
    recurrence_rule: null, flex_period: 'month', flex_target: 4 }

  it('week practice counts only completions from the week-start', () => {
    const done = [
      { practice_id: 'p', completed_on: '2026-06-15' }, // this week (Mon)
      { practice_id: 'p', completed_on: '2026-06-08' }, // last week — excluded
    ]
    expect(doneThisPeriod(weekP, done, '2026-06-15', '2026-06-17')).toBe(1)
  })
  it('month practice counts completions from the month-start, across weeks', () => {
    const done = [
      { practice_id: 'p', completed_on: '2026-06-02' }, // earlier in the month
      { practice_id: 'p', completed_on: '2026-06-15' },
      { practice_id: 'p', completed_on: '2026-05-31' }, // previous month — excluded
    ]
    expect(doneThisPeriod(monthP, done, '2026-06-15', '2026-06-17')).toBe(2)
  })
  it('ignores completions for other practices and after the date', () => {
    const done = [
      { practice_id: 'p', completed_on: '2026-06-16' },
      { practice_id: 'other', completed_on: '2026-06-16' }, // other practice — excluded
      { practice_id: 'p', completed_on: '2026-06-18' }, // after `date` — excluded
    ]
    expect(doneThisPeriod(weekP, done, '2026-06-15', '2026-06-17')).toBe(1)
  })
})
