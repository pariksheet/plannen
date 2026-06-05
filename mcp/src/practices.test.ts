import { describe, it, expect } from 'vitest'
import {
  weekBoundaryStart,
  dayOfWeekKey,
  isPracticeDueOn,
  remainingThisWeek,
  type PracticeRow,
  type CompletionRow,
} from './practices.js'

function practice(p: Partial<PracticeRow>): PracticeRow {
  return {
    id: p.id ?? 'p1',
    user_id: p.user_id ?? 'u1',
    family_member_id: p.family_member_id ?? null,
    name: p.name ?? 'Gym',
    category: p.category ?? 'health',
    frequency_type: p.frequency_type ?? 'daily',
    target_count: p.target_count ?? null,
    days_of_week: p.days_of_week ?? null,
    preferred_time_of_day: p.preferred_time_of_day ?? 'anytime',
    active: p.active ?? true,
  }
}

describe('weekBoundaryStart', () => {
  it('returns Monday for a Wednesday', () => {
    expect(weekBoundaryStart('2026-05-20')).toBe('2026-05-18')
  })
  it('returns Monday for a Sunday (boundary day)', () => {
    // 2026-05-24 is Sunday. Week boundary = Mon 2026-05-18.
    expect(weekBoundaryStart('2026-05-24')).toBe('2026-05-18')
  })
  it('returns same date when called on Monday', () => {
    expect(weekBoundaryStart('2026-05-18')).toBe('2026-05-18')
  })
})

describe('dayOfWeekKey', () => {
  it('maps Monday 2026-05-18 to "mon"', () => {
    expect(dayOfWeekKey('2026-05-18')).toBe('mon')
  })
  it('maps Saturday 2026-05-23 to "sat"', () => {
    expect(dayOfWeekKey('2026-05-23')).toBe('sat')
  })
})

describe('isPracticeDueOn', () => {
  it('daily practice is due every day', () => {
    const p = practice({ frequency_type: 'daily' })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(true)
  })
  it('weekly_count practice is due if remaining > 0', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 3 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
    ]
    expect(isPracticeDueOn(p, '2026-05-20', completions)).toBe(true)
  })
  it('weekly_count practice is NOT due when target met', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 2 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
    ]
    expect(isPracticeDueOn(p, '2026-05-20', completions)).toBe(false)
  })
  it('specific_days practice respects days_of_week', () => {
    const p = practice({ frequency_type: 'specific_days', days_of_week: ['mon', 'wed', 'fri'] })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(true)  // Wednesday
    expect(isPracticeDueOn(p, '2026-05-21', [])).toBe(false) // Thursday
  })
  it('inactive practice never due', () => {
    const p = practice({ active: false })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(false)
  })
  it('weekly_count with null target_count is not due (defensive)', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: null })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(false)
  })
})

describe('remainingThisWeek', () => {
  it('returns null for daily practice', () => {
    const p = practice({ frequency_type: 'daily' })
    expect(remainingThisWeek(p, '2026-05-20', [])).toBeNull()
  })
  it('counts only completions in the current week', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 3 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-17' }, // last week (Sun)
      { practice_id: 'p1', completed_on: '2026-05-18' }, // this week Mon
      { practice_id: 'p1', completed_on: '2026-05-19' }, // this week Tue
    ]
    expect(remainingThisWeek(p, '2026-05-20', completions)).toBe(1)
  })
  it('floors at 0 when over-completed', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 2 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
      { practice_id: 'p1', completed_on: '2026-05-20' },
    ]
    expect(remainingThisWeek(p, '2026-05-20', completions)).toBe(0)
  })
  it('returns null when target_count is null on a weekly practice', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: null })
    expect(remainingThisWeek(p, '2026-05-20', [])).toBeNull()
  })
})
