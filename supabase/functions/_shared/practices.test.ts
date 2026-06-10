import { describe, it, expect } from 'vitest'
import {
  weekBoundaryStart,
  monthBoundaryStart,
  dayOfWeekKey,
  occursOn,
  isPracticeDueOn,
  remainingThisPeriod,
  type PracticeRow,
} from './practices.ts'

const base = {
  id: 'p1', user_id: 'u1', family_member_id: null,
  name: 'x', category: 'household' as const,
  preferred_time_of_day: 'anytime' as const, active: true,
  recurrence_until: null,
}

describe('weekBoundaryStart', () => {
  it('returns Monday for a Wednesday', () => {
    expect(weekBoundaryStart('2026-05-20')).toBe('2026-05-18')
  })
  it('returns same date when called on Monday', () => {
    expect(weekBoundaryStart('2026-05-18')).toBe('2026-05-18')
  })
})

describe('monthBoundaryStart', () => {
  it('returns the 1st of the month', () => {
    expect(monthBoundaryStart('2026-05-20')).toBe('2026-05-01')
  })
})

describe('dayOfWeekKey', () => {
  it('maps Monday 2026-05-18 to "mon"', () => {
    expect(dayOfWeekKey('2026-05-18')).toBe('mon')
  })
})

describe('occursOn — daily interval (every-N-days / meal prep)', () => {
  const rule = { frequency: 'daily' as const, interval: 2 }
  it('is due on the anchor day', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-01')).toBe(true)
  })
  it('is due two days after the anchor', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-03')).toBe(true)
  })
  it('is NOT due on the off day', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-02')).toBe(false)
  })
  it('is NOT due before the anchor', () => {
    expect(occursOn(rule, '2026-06-01', '2026-05-31')).toBe(false)
  })
  it('treats interval 1 as plain daily', () => {
    expect(occursOn({ frequency: 'daily' }, '2026-06-01', '2026-06-05')).toBe(true)
  })
})

describe('occursOn — weekly with days + interval', () => {
  const rule = { frequency: 'weekly' as const, days: ['MO', 'WE', 'FR'] }
  it('is due on a listed weekday', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-03')).toBe(true) // Wed
  })
  it('is NOT due on an unlisted weekday', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-02')).toBe(false) // Tue
  })
  it('respects a 2-week interval (off-week suppressed)', () => {
    const biweekly = { frequency: 'weekly' as const, days: ['MO'], interval: 2 }
    expect(occursOn(biweekly, '2026-06-01', '2026-06-01')).toBe(true)  // anchor Mon
    expect(occursOn(biweekly, '2026-06-01', '2026-06-08')).toBe(false) // next Mon (off week)
    expect(occursOn(biweekly, '2026-06-01', '2026-06-15')).toBe(true)  // +2 weeks
  })
})

describe('occursOn — monthly', () => {
  const rule = { frequency: 'monthly' as const }
  it('is due on the same day-of-month as the anchor', () => {
    expect(occursOn(rule, '2026-06-10', '2026-07-10')).toBe(true)
  })
  it('is NOT due on a different day-of-month', () => {
    expect(occursOn(rule, '2026-06-10', '2026-07-11')).toBe(false)
  })
})

describe('isPracticeDueOn', () => {
  it('pinned daily-interval practice uses occursOn', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily', interval: 2 }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(true)
    expect(isPracticeDueOn(p, '2026-06-02', [])).toBe(false)
  })
  it('inactive practice is never due', () => {
    const p: PracticeRow = { ...base, active: false, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(false)
  })
  it('pinned practice past recurrence_until is not due', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      recurrence_until: '2026-06-02', flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-05', [])).toBe(false)
  })
  it('flex_count week practice is due while under target', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 3 }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(true)
  })
  it('flex_count week practice is NOT due once target met this week', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 2 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' },
      { practice_id: 'p1', completed_on: '2026-06-02' },
    ]
    expect(isPracticeDueOn(p, '2026-06-03', done)).toBe(false)
  })
  it('flex_count month practice counts within the calendar month', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'month', flex_target: 1 }
    const done = [{ practice_id: 'p1', completed_on: '2026-05-31' }] // previous month
    expect(isPracticeDueOn(p, '2026-06-10', done)).toBe(true)
  })
})

describe('remainingThisPeriod', () => {
  it('returns null for a pinned practice', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(remainingThisPeriod(p, '2026-06-03', [])).toBeNull()
  })
  it('counts only completions in the current week', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 3 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' }, // this week (Mon)
      { practice_id: 'p1', completed_on: '2026-05-25' }, // last week
    ]
    expect(remainingThisPeriod(p, '2026-06-03', done)).toBe(2)
  })
  it('floors at 0 when over-completed', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 1 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' },
      { practice_id: 'p1', completed_on: '2026-06-02' },
    ]
    expect(remainingThisPeriod(p, '2026-06-03', done)).toBe(0)
  })
})
