import type { PracticeRow } from '../lib/dbClient/types'

const CODE_TO_NAME: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
}

/** "Gym (2/3 this week)", "Meal prep (every 2 days)", "Walk (Mon/Wed/Fri)". */
export function practiceLabel(p: PracticeRow, doneThisPeriodCount: number): string {
  if (p.recurrence_mode === 'flex_count') {
    return `${p.name} (${doneThisPeriodCount}/${p.flex_target ?? 0} this ${p.flex_period})`
  }
  const r = p.recurrence_rule
  if (!r) return p.name
  if (r.frequency === 'daily') {
    return (r.interval ?? 1) > 1 ? `${p.name} (every ${r.interval} days)` : `${p.name} (daily)`
  }
  if (r.frequency === 'weekly') {
    const days = (r.days ?? []).map((c) => CODE_TO_NAME[c] ?? c).join('/')
    return days ? `${p.name} (${days})` : p.name
  }
  if (r.frequency === 'monthly') return `${p.name} (monthly)`
  return p.name
}

/** Start of the calendar month for an ISO date, "YYYY-MM-01". */
export function monthStartIso(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** Start of the period this practice counts in, for an ISO date. */
export function practicePeriodStart(p: PracticeRow, weekStart: string, date: string): string {
  if (p.recurrence_mode === 'flex_count' && p.flex_period === 'month') return monthStartIso(date)
  return weekStart
}

/** Completions for `p` within its current period, given completions since month-start. */
export function doneThisPeriod(
  p: PracticeRow,
  completions: { practice_id: string; completed_on: string }[],
  weekStart: string,
  date: string,
): number {
  const from = practicePeriodStart(p, weekStart, date)
  return completions.filter(
    (c) => c.practice_id === p.id && c.completed_on >= from && c.completed_on <= date,
  ).length
}
