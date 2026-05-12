import { addDays, addWeeks, addMonths } from 'date-fns'

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  /** Day codes for weekly recurrence, e.g. ['MO', 'WE', 'FR'] */
  days?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[]
  count?: number
  until?: string
  session_duration_minutes?: number
}

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
}

function applyTimeOfDay(target: Date, source: Date): Date {
  const d = new Date(target.getTime())
  d.setUTCHours(source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), 0)
  return d
}

/** Generate session start/end date pairs for a recurring event. */
export function generateSessionDates(
  parentStartDate: string,
  rule: RecurrenceRule,
): { start: Date; end: Date | null }[] {
  const start = new Date(parentStartDate)
  const until = rule.until ? new Date(rule.until) : null
  const interval = rule.interval ?? 1
  const durationMs = rule.session_duration_minutes ? rule.session_duration_minutes * 60_000 : null
  const results: { start: Date; end: Date | null }[] = []

  const addResult = (d: Date) => {
    const sessionStart = applyTimeOfDay(new Date(d), start)
    const sessionEnd = durationMs ? new Date(sessionStart.getTime() + durationMs) : null
    results.push({ start: sessionStart, end: sessionEnd })
  }

  if (rule.frequency === 'weekly' && rule.days?.length) {
    const targetDays = rule.days.map((c) => DAY_CODE_TO_JS[c]).filter((n) => n !== undefined)
    // For each target day, find the first occurrence on or after start
    const seeds: Date[] = []
    for (const targetDay of targetDays) {
      const diff = (targetDay - start.getDay() + 7) % 7
      seeds.push(addDays(start, diff))
    }
    seeds.sort((a, b) => a.getTime() - b.getTime())

    // Merge all day streams, advancing week by week
    const cursors = [...seeds]
    while (results.length < (rule.count ?? Infinity)) {
      // Pick the earliest cursor
      let minIdx = 0
      for (let i = 1; i < cursors.length; i++) {
        if (cursors[i] < cursors[minIdx]) minIdx = i
      }
      const current = cursors[minIdx]
      if (until && current > until) break
      if (!rule.count && !until) break
      addResult(current)
      cursors[minIdx] = addWeeks(current, interval)
    }
  } else if (rule.frequency === 'daily') {
    let current = new Date(start)
    while (results.length < (rule.count ?? Infinity)) {
      if (until && current > until) break
      if (!rule.count && !until) break
      addResult(current)
      current = addDays(current, interval)
    }
  } else if (rule.frequency === 'monthly') {
    let current = new Date(start)
    while (results.length < (rule.count ?? Infinity)) {
      if (until && current > until) break
      if (!rule.count && !until) break
      addResult(current)
      current = addMonths(current, interval)
    }
  }

  return results
}
