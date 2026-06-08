import { Event } from '../types/event'

export interface DayBucket {
  dateKey: string   // "YYYY-MM-DD" local day
  /** Display-only, locale-dependent label (e.g. "Wed"). Do not branch on its content. */
  weekday: string
  dayNum: number    // 10
  isToday: boolean
  isPast: boolean    // whole day before today
  events: Event[]    // sorted ascending by start_date
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Date-only ISO ("2026-06-10") taken as-is; a timestamp is converted to the
// user's local date.
export function eventDateLocal(event: Event): string {
  if (event.start_date.length <= 10) return event.start_date.slice(0, 10)
  const d = new Date(event.start_date)
  if (Number.isNaN(d.getTime())) return event.start_date.slice(0, 10)
  return ymd(d)
}

// Monday..Sunday of the week containing `now`.
export function weekDays(now: Date): Date[] {
  const dow = now.getDay() || 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow - 1))
  monday.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

// Buckets events into the current Mon–Sun week, one entry per day that has
// events (today is always included even if empty; other empty days are
// omitted). Recurrence parents are skipped; reminders are kept, including
// past ones.
export function buildWeekAgenda(events: Event[], now: Date): DayBucket[] {
  const days = weekDays(now)
  const todayKey = ymd(now)
  const weekStart = ymd(days[0])
  const weekEnd = ymd(days[6])

  const byDay = new Map<string, Event[]>()
  for (const e of events) {
    if (e.recurrence_rule) continue
    const k = eventDateLocal(e)
    if (k < weekStart || k > weekEnd) continue
    const arr = byDay.get(k) ?? []
    arr.push(e)
    byDay.set(k, arr)
  }

  const buckets: DayBucket[] = []
  for (const d of days) {
    const dateKey = ymd(d)
    const isToday = dateKey === todayKey
    const evs = (byDay.get(dateKey) ?? []).slice()
      .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
    if (evs.length === 0 && !isToday) continue
    buckets.push({
      dateKey,
      weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
      dayNum: d.getDate(),
      isToday,
      isPast: dateKey < todayKey,
      events: evs,
    })
  }
  return buckets
}
