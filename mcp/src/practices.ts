// Pure helpers for the daily-plan agent. No DB / IO.
// All date arguments are UTC calendar dates ("YYYY-MM-DD"). Callers must
// normalise to UTC before passing (e.g. new Date().toISOString().slice(0, 10)).

export type RecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[] // two-letter codes: MO,TU,WE,TH,FR,SA,SU (same as events)
}

export type PracticeRow = {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule: RecurrenceRule | null
  dtstart: string // YYYY-MM-DD
  recurrence_until: string | null // YYYY-MM-DD
  flex_period: 'week' | 'month' | null
  flex_target: number | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
}

export type CompletionRow = {
  practice_id: string
  completed_on: string // YYYY-MM-DD
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
// RecurrenceRule.days uses two-letter codes; map to the ISO weekday name.
const CODE_TO_KEY: Record<string, typeof DAY_KEYS[number]> = {
  SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat',
}

function midnightUtcMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime()
}

function daysBetween(a: string, b: string): number {
  return Math.round((midnightUtcMs(b) - midnightUtcMs(a)) / 86_400_000)
}

/** ISO weekday: Mon=1..Sun=7. */
function weekday(date: string): number {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  return js === 0 ? 7 : js
}

/** Returns the Monday of the ISO week containing `date`, as "YYYY-MM-DD". */
export function weekBoundaryStart(date: string): string {
  const wd = weekday(date)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

/** Returns the 1st of the calendar month containing `date`, as "YYYY-MM-DD". */
export function monthBoundaryStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** "mon"/"tue"/.../"sun" for an ISO date. */
export function dayOfWeekKey(date: string): typeof DAY_KEYS[number] {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay()
  return DAY_KEYS[js]
}

/**
 * Does `rule` (anchored at `dtstart`) produce an occurrence on `date`?
 * Interval is counted from `dtstart`: every-2-days from Jun 1 lands on
 * Jun 1, 3, 5… Weekly interval is counted in whole ISO weeks; monthly in
 * whole calendar months on the same day-of-month as the anchor.
 */
export function occursOn(rule: RecurrenceRule, dtstart: string, date: string): boolean {
  if (date < dtstart) return false
  const interval = rule.interval ?? 1
  switch (rule.frequency) {
    case 'daily': {
      const diff = daysBetween(dtstart, date)
      return diff >= 0 && diff % interval === 0
    }
    case 'weekly': {
      const key = dayOfWeekKey(date)
      const days = (rule.days ?? []).map((c) => CODE_TO_KEY[c]).filter(Boolean)
      if (!days.includes(key)) return false
      const weeks = Math.round(daysBetween(weekBoundaryStart(dtstart), weekBoundaryStart(date)) / 7)
      return weeks >= 0 && weeks % interval === 0
    }
    case 'monthly': {
      if (date.slice(8, 10) !== dtstart.slice(8, 10)) return false
      const months =
        (Number(date.slice(0, 4)) - Number(dtstart.slice(0, 4))) * 12 +
        (Number(date.slice(5, 7)) - Number(dtstart.slice(5, 7)))
      return months >= 0 && months % interval === 0
    }
  }
}

function periodStart(period: 'week' | 'month', date: string): string {
  return period === 'week' ? weekBoundaryStart(date) : monthBoundaryStart(date)
}

function completionsInPeriodOf(practice: PracticeRow, date: string, completions: CompletionRow[]): number {
  if (practice.flex_period === null) return 0
  const start = periodStart(practice.flex_period, date)
  return completions.filter(
    (c) => c.practice_id === practice.id && c.completed_on >= start && c.completed_on <= date,
  ).length
}

export function isPracticeDueOn(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): boolean {
  if (!practice.active) return false
  if (practice.recurrence_mode === 'pinned') {
    if (!practice.recurrence_rule) return false
    if (practice.recurrence_until && date > practice.recurrence_until) return false
    return occursOn(practice.recurrence_rule, practice.dtstart, date)
  }
  // flex_count
  if (practice.flex_target === null) return false
  return completionsInPeriodOf(practice, date, completions) < practice.flex_target
}

/** Remaining completions needed this period (null for pinned practices). */
export function remainingThisPeriod(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): number | null {
  if (practice.recurrence_mode !== 'flex_count' || practice.flex_target === null) return null
  const done = completionsInPeriodOf(practice, date, completions)
  return Math.max(0, practice.flex_target - done)
}
