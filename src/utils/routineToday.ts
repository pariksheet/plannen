import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import { occursOn } from './scheduling'
import { practiceLabel, doneThisPeriod } from './practiceLabel'

export type TodayRoutine = {
  id: string
  label: string
  done: boolean
  sortMins: number
  timeLabel: string
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Part-of-day → a synthetic minutes-of-day sort key so routines interleave
 *  among the day's timed items. A valid precise_time wins; `anytime` sorts last. */
export function partOfDayMins(
  tod: PracticeRow['preferred_time_of_day'],
  preciseTime?: string | null,
): number {
  if (preciseTime && HHMM.test(preciseTime)) {
    const [h, m] = preciseTime.split(':').map(Number)
    return h * 60 + m
  }
  switch (tod) {
    case 'morning': return 480    // 08:00
    case 'afternoon': return 780  // 13:00
    case 'evening': return 1080   // 18:00
    default: return Number.POSITIVE_INFINITY // anytime → end of day
  }
}

/** Is this routine applicable on `date`? Pinned: cadence fires today (active,
 *  within recurrence_until). Flex: still under its period target.
 *  Composed from the existing web utils — behaviourally equal to the server's
 *  isPracticeDueOn without adding a new engine mirror. */
export function isRoutineApplicableToday(
  p: PracticeRow,
  date: string,
  completions: PracticeCompletionRow[],
  weekStart: string,
): boolean {
  if (!p.active) return false
  if (p.recurrence_mode === 'pinned') {
    if (!p.recurrence_rule) return false
    if (p.recurrence_until && date > p.recurrence_until) return false
    return occursOn(p.recurrence_rule, p.dtstart, date)
  }
  // flex_count
  if (p.flex_target == null) return false
  return doneThisPeriod(p, completions, weekStart, date) < p.flex_target
}

/** The today-applicable routines, labelled + done-flagged + sorted by part-of-day. */
export function applicableTodayRoutines(
  practices: PracticeRow[],
  completions: PracticeCompletionRow[],
  date: string,
  weekStart: string,
): TodayRoutine[] {
  return practices
    .filter((p) => isRoutineApplicableToday(p, date, completions, weekStart))
    .map((p) => ({
      id: p.id,
      label: practiceLabel(p, doneThisPeriod(p, completions, weekStart, date)),
      done: completions.some((c) => c.practice_id === p.id && c.completed_on === date),
      sortMins: partOfDayMins(p.preferred_time_of_day, p.precise_time),
      timeLabel: p.precise_time && HHMM.test(p.precise_time) ? p.precise_time : '',
    }))
    .sort((a, b) => a.sortMins - b.sortMins)
}
