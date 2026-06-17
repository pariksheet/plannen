import { describe, it, expect } from 'vitest'
import { partOfDayMins, isRoutineApplicableToday, applicableTodayRoutines } from './routineToday'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'

const base = {
  id: 'p', user_id: 'u', family_member_id: null, name: 'X',
  category: 'household' as const, dtstart: '2026-06-01', recurrence_until: null,
  preferred_time_of_day: 'anytime' as const, precise_time: null as string | null,
  active: true, created_at: '', updated_at: '',
}
// 2026-06-10 is a Wednesday; ISO week starts Mon 2026-06-08.
const WED = '2026-06-10'
const WEEK_START = '2026-06-08'

describe('partOfDayMins', () => {
  it('maps each part of day to a sort key', () => {
    expect(partOfDayMins('morning')).toBe(480)
    expect(partOfDayMins('afternoon')).toBe(780)
    expect(partOfDayMins('evening')).toBe(1080)
    expect(partOfDayMins('anytime')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('isRoutineApplicableToday', () => {
  it('pinned daily routine fires today', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(true)
  })
  it('pinned weekly routine NOT firing today is excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'weekly', days: ['MO'] }, flex_period: null, flex_target: null } // Wed != Mon
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('inactive routine excluded', () => {
    const p: PracticeRow = { ...base, active: false, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('pinned past recurrence_until excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, recurrence_until: '2026-06-05',
      flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('flex routine under target is applicable', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 3 }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'p', completed_on: '2026-06-08' } as PracticeCompletionRow,
    ]
    expect(isRoutineApplicableToday(p, WED, done, WEEK_START)).toBe(true)
  })
  it('flex routine at target is excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 2 }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'p', completed_on: '2026-06-08' } as PracticeCompletionRow,
      { practice_id: 'p', completed_on: '2026-06-09' } as PracticeCompletionRow,
    ]
    expect(isRoutineApplicableToday(p, WED, done, WEEK_START)).toBe(false)
  })
})

describe('partOfDayMins with precise_time', () => {
  it('returns minutes-of-day for a valid HH:MM, ignoring part-of-day', () => {
    expect(partOfDayMins('anytime', '20:00')).toBe(1200)
    expect(partOfDayMins('morning', '06:30')).toBe(390)
  })
  it('falls back to part-of-day when precise_time is null or invalid', () => {
    expect(partOfDayMins('morning', null)).toBe(480)
    expect(partOfDayMins('evening', '99:99')).toBe(1080)
    expect(partOfDayMins('anytime')).toBe(Number.POSITIVE_INFINITY)
  })
  it('a timed routine sorts between two events by minutes', () => {
    const eventA = 18 * 60 + 15 // 1095
    const eventB = 21 * 60      // 1260
    const routine = partOfDayMins('anytime', '20:00') // 1200
    expect(eventA).toBeLessThan(routine)
    expect(routine).toBeLessThan(eventB)
  })
})

describe('applicableTodayRoutines', () => {
  it('filters, labels, marks done, and sorts by part-of-day', () => {
    const vitamins: PracticeRow = { ...base, id: 'v', name: 'Vitamins',
      recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' },
      preferred_time_of_day: 'morning', flex_period: null, flex_target: null }
    const gym: PracticeRow = { ...base, id: 'g', name: 'Gym',
      recurrence_mode: 'flex_count', recurrence_rule: null,
      preferred_time_of_day: 'anytime', flex_period: 'week', flex_target: 3 }
    const monthly: PracticeRow = { ...base, id: 'm', name: 'Deep clean',
      recurrence_mode: 'pinned', recurrence_rule: { frequency: 'monthly' }, // dtstart day 01, today day 10 → not due
      preferred_time_of_day: 'evening', flex_period: null, flex_target: null }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'g', completed_on: '2026-06-09' } as PracticeCompletionRow, // gym 1/3
      { practice_id: 'v', completed_on: WED } as PracticeCompletionRow,          // vitamins done today
    ]
    const rows = applicableTodayRoutines([gym, vitamins, monthly], done, WED, WEEK_START)
    // monthly (day 01 cadence) not due on day 10 → excluded; gym + vitamins remain.
    expect(rows.map((r) => r.id)).toEqual(['v', 'g']) // morning(480) before anytime(∞)
    expect(rows[0]).toMatchObject({ label: 'Vitamins (daily)', done: true, sortMins: 480 })
    expect(rows[1]).toMatchObject({ label: 'Gym (1/3 this week)', done: false, sortMins: Number.POSITIVE_INFINITY })
  })
})
