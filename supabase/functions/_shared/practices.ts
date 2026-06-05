// NOTE: This file is duplicated from mcp/src/practices.ts so the edge function
// runtime (Deno) can import it. Keep in sync. If they drift, fix here first
// then back-port to mcp/src/practices.ts (or vice versa).

// Pure helpers for the daily-plan agent. No DB / IO.
// All date arguments are UTC calendar dates ("YYYY-MM-DD"). Callers must
// normalise to UTC before passing (e.g. new Date().toISOString().slice(0, 10)).

export type PracticeRow = {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  frequency_type: 'daily' | 'weekly_count' | 'specific_days'
  target_count: number | null
  days_of_week: string[] | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
}

export type CompletionRow = {
  practice_id: string
  completed_on: string // YYYY-MM-DD
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** ISO weekday: Mon=1..Sun=7. Date string is "YYYY-MM-DD". */
function weekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`)
  const js = d.getUTCDay() // 0=Sun..6=Sat
  return js === 0 ? 7 : js
}

/** Returns the Monday of the ISO week containing `date`, as "YYYY-MM-DD". */
export function weekBoundaryStart(date: string): string {
  const wd = weekday(date)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

/** "mon"/"tue"/.../"sun" for an ISO date. */
export function dayOfWeekKey(date: string): typeof DAY_KEYS[number] {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay()
  return DAY_KEYS[js]
}

function completionsInWeekOf(practice: PracticeRow, date: string, completions: CompletionRow[]): number {
  const start = weekBoundaryStart(date)
  const startD = new Date(`${start}T00:00:00Z`).getTime()
  const endD = startD + 7 * 24 * 3600 * 1000 // exclusive
  return completions.filter((c) => {
    if (c.practice_id !== practice.id) return false
    const t = new Date(`${c.completed_on}T00:00:00Z`).getTime()
    return t >= startD && t < endD
  }).length
}

export function isPracticeDueOn(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): boolean {
  if (!practice.active) return false
  switch (practice.frequency_type) {
    case 'daily':
      return true
    case 'weekly_count': {
      // target_count is required when frequency_type='weekly_count'; if null,
      // the row is misconfigured — don't surface it as due.
      if (practice.target_count === null) return false
      return completionsInWeekOf(practice, date, completions) < practice.target_count
    }
    case 'specific_days': {
      const today = dayOfWeekKey(date)
      return practice.days_of_week?.includes(today) ?? false
    }
  }
}

/** Remaining completions needed this week (null for non-weekly-count). */
export function remainingThisWeek(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): number | null {
  if (practice.frequency_type !== 'weekly_count') return null
  if (practice.target_count === null) return null
  const done = completionsInWeekOf(practice, date, completions)
  return Math.max(0, practice.target_count - done)
}
