import { Event } from '../types/event'
import { addYears, startOfDay } from 'date-fns'

/** Date used to position an event on the timeline. watching/missed show at +1 year (next expected occurrence). For multi-day events, uses preferred_visit_date if within range. */
export function getTimelineDate(
  event: Event,
  preferredVisitDate?: string | null
): Date {
  const d = new Date(event.start_date)
  if (event.event_status === 'watching' || event.event_status === 'missed') {
    return addYears(d, 1)
  }
  // Multi-day: use preferred visit date if set and within event range
  if (preferredVisitDate && event.end_date) {
    const start = new Date(event.start_date).getTime()
    const end = new Date(event.end_date).getTime()
    const preferred = new Date(preferredVisitDate).getTime()
    if (preferred >= start && preferred <= end) return new Date(preferredVisitDate)
  }
  // Ongoing multi-day event with no preferred date: anchor to today so it shows in the current month
  if (event.end_date) {
    const end = new Date(event.end_date)
    const now = new Date()
    if (d < now && end > now) return now
  }
  return d
}

export interface TimelineItem {
  event: Event
  timelineDate: Date
  isImmediateNext: boolean
  /** True if the event is today but its start time has already passed. */
  isPastToday: boolean
  /** For wishlist/missed: the "next occurrence" date we're showing (same as timelineDate). */
  nextExpectedDate?: Date
}

const TIMELINE_STATUSES = new Set(['watching', 'planned', 'interested', 'going', 'missed'])

/** Build future timeline: active + missed events sorted by timeline date. First item is "immediate next". Uses preferred_visit_date for multi-day when provided. */
export function buildFutureTimeline(
  events: Event[],
  preferredVisitDateByEventId?: Record<string, string | null>
): TimelineItem[] {
  const currentMoment = new Date()
  const startOfToday = startOfDay(currentMoment)
  const future: Event[] = events.filter(
    // Exclude recurring parents — their child sessions carry the individual dates
    (e) => TIMELINE_STATUSES.has(e.event_status) && !e.recurrence_rule
  )
  const withDates = future.map((event) => {
    const preferred = preferredVisitDateByEventId?.[event.id]
    const timelineDate = getTimelineDate(event, preferred)
    return {
      event,
      timelineDate,
      isImmediateNext: false,
      isPastToday: false,
      nextExpectedDate:
        event.event_status === 'watching' || event.event_status === 'missed' ? getTimelineDate(event) : undefined,
    }
  })
  const sorted = withDates
    .filter((i) => i.timelineDate >= startOfToday)
    .sort((a, b) => a.timelineDate.getTime() - b.timelineDate.getTime())
    .map((item) => ({ ...item, isPastToday: item.timelineDate < currentMoment }))
  const immediateNextIdx = sorted.findIndex((i) => !i.isPastToday)
  if (immediateNextIdx >= 0) {
    sorted[immediateNextIdx].isImmediateNext = true
  } else if (sorted.length > 0) {
    sorted[sorted.length - 1].isImmediateNext = true
  }
  return sorted
}

/** Group timeline items by month/year key "YYYY-MM" for section headers. */
export function groupTimelineByMonth(items: TimelineItem[]): { monthKey: string; label: string; items: TimelineItem[] }[] {
  const byMonth = new Map<string, TimelineItem[]>()
  for (const item of items) {
    const y = item.timelineDate.getFullYear()
    const m = item.timelineDate.getMonth()
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)!.push(item)
  }
  const keys = Array.from(byMonth.keys()).sort()
  return keys.map((monthKey) => {
    const [y, m] = monthKey.split('-').map(Number)
    const date = new Date(y, m - 1, 1)
    const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    return { monthKey, label, items: byMonth.get(monthKey)! }
  })
}
