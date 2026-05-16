const DAY_CODE_TO_JS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function addWeeks(d: Date, n: number): Date { return new Date(d.getTime() + n * 7 * 86400_000) }
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86400_000) }
function addMonths(d: Date, n: number): Date {
  const r = new Date(d); r.setUTCMonth(r.getUTCMonth() + n); return r
}

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[]
  count?: number
  until?: string
  session_duration_minutes?: number
}

function getLocalParts(utc: Date, tz: string) {
  // hourCycle: 'h23' forces 0–23 hours. With { hour12: false } alone, Node 20's
  // ICU emits "24" for the post-midnight hour on some DST boundaries, which
  // Number-parses to 24 and corrupts the subsequent Date.UTC round-trip.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(utc)
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  }
}

// Convert a local wall-clock time in `tz` to its UTC instant.
// Treat the components as if they were UTC, ask Intl what local time that lands on
// in `tz`, the gap is exactly the tz offset at that moment.
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s)
  const back = getLocalParts(new Date(asUtc), tz)
  const backAsUtc = Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, back.second)
  return new Date(asUtc - (backAsUtc - asUtc))
}

export function generateSessionDates(
  parentStartDate: string,
  rule: RecurrenceRule,
  tz: string = 'UTC',
): { start: Date; end: Date | null }[] {
  const start = new Date(parentStartDate)
  const local = getLocalParts(start, tz)
  const { hour: lh, minute: lmin, second: lsec } = local

  // Date-only `until` (YYYY-MM-DD) is inclusive of the whole day in `tz`.
  const until = rule.until
    ? (/^\d{4}-\d{2}-\d{2}$/.test(rule.until)
        ? (() => {
            const [yy, mm, dd] = rule.until.split('-').map(Number)
            return zonedToUtc(yy, mm, dd, 23, 59, 59, tz)
          })()
        : new Date(rule.until))
    : null

  const interval = rule.interval ?? 1
  const durationMs = rule.session_duration_minutes ? rule.session_duration_minutes * 60_000 : null
  const results: { start: Date; end: Date | null }[] = []

  // Anchor for calendar math: a midnight-UTC Date whose Y/M/D match the local
  // calendar in `tz`. Used only for day-of-week / addDays / addMonths arithmetic;
  // the real UTC instant for each occurrence is computed via zonedToUtc.
  const localStartDay = new Date(Date.UTC(local.year, local.month - 1, local.day))

  const tryAdd = (localDay: Date): boolean => {
    const startUtc = zonedToUtc(
      localDay.getUTCFullYear(), localDay.getUTCMonth() + 1, localDay.getUTCDate(),
      lh, lmin, lsec, tz,
    )
    if (until && startUtc > until) return false
    results.push({ start: startUtc, end: durationMs ? new Date(startUtc.getTime() + durationMs) : null })
    return true
  }

  if (rule.frequency === 'weekly' && rule.days?.length) {
    const targetDays = rule.days.map((c) => DAY_CODE_TO_JS[c]).filter((n) => n !== undefined)
    const seeds: Date[] = targetDays.map((td) => addDays(localStartDay, (td - localStartDay.getUTCDay() + 7) % 7))
    seeds.sort((a, b) => a.getTime() - b.getTime())
    const cursors = [...seeds]
    while (results.length < (rule.count ?? Infinity)) {
      let minIdx = 0
      for (let i = 1; i < cursors.length; i++) if (cursors[i] < cursors[minIdx]) minIdx = i
      const cur = cursors[minIdx]
      if (!rule.count && !until) break
      if (!tryAdd(cur)) break
      cursors[minIdx] = addWeeks(cur, interval)
    }
  } else if (rule.frequency === 'daily') {
    let cur = localStartDay
    while (results.length < (rule.count ?? Infinity)) {
      if (!rule.count && !until) break
      if (!tryAdd(cur)) break
      cur = addDays(cur, interval)
    }
  } else if (rule.frequency === 'monthly') {
    let cur = localStartDay
    while (results.length < (rule.count ?? Infinity)) {
      if (!rule.count && !until) break
      if (!tryAdd(cur)) break
      cur = addMonths(cur, interval)
    }
  }
  return results
}
