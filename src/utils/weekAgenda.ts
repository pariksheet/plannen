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

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000 // assume 2h when no end_date

// Indicative attendance instances are deliberately NOT passed here — like
// reminders, they are context, not commitments, so they never clash. Only
// Event rows are accepted. Obligations are actionable but rendered separately.
//
// Ids of timed events whose clock ranges intersect another timed event in the
// same list. Date-only (all-day) events never count as clashing, and back-to-
// back events that merely touch (a.end === b.start) do not overlap. Reminders
// are nudges, not attendance commitments, so they're excluded entirely — a
// reminder never clashes and never makes another event clash.
export function overlappingIds(events: Event[]): Set<string> {
  const timed = events
    .filter((e) => e.event_kind !== 'reminder' && e.start_date.length > 10)
    .map((e) => {
      const start = new Date(e.start_date).getTime()
      const end = e.end_date ? new Date(e.end_date).getTime() : start + DEFAULT_DURATION_MS
      return { id: e.id, start, end: Math.max(end, start) }
    })
    .filter((x) => Number.isFinite(x.start))
  const clash = new Set<string>()
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[i].start < timed[j].end && timed[j].start < timed[i].end) {
        clash.add(timed[i].id)
        clash.add(timed[j].id)
      }
    }
  }
  return clash
}
