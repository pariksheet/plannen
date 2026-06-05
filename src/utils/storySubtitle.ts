import { format, parseISO } from 'date-fns'

export interface StoryEventSummary {
  id: string
  title: string | null
  start_date: string | null
}

export interface SubtitleInput {
  events: StoryEventSummary[]
  date_from?: string | null
  date_to?: string | null
}

function formatRange(fromIso: string, toIso: string): string {
  const a = parseISO(fromIso)
  const b = parseISO(toIso)
  if (a.getFullYear() === b.getFullYear()) {
    if (a.getMonth() === b.getMonth()) {
      return `${format(a, 'MMM d')}–${format(b, 'd, yyyy')}`
    }
    return `${format(a, 'MMM d')} – ${format(b, 'MMM d, yyyy')}`
  }
  return `${format(a, 'MMM yyyy')} – ${format(b, 'MMM yyyy')}`
}

export function formatStorySubtitle({ events, date_from, date_to }: SubtitleInput): string {
  if (events.length === 1) {
    const e = events[0]
    const title = e.title ?? 'Untitled event'
    if (!e.start_date) return title
    const date = format(parseISO(e.start_date), 'MMM d, yyyy')
    return `${title} · ${date}`
  }
  if (events.length > 1) {
    const sorted = [...events].sort((a, b) =>
      (a.start_date ?? '').localeCompare(b.start_date ?? '')
    )
    const first = sorted[0].start_date
    const last = sorted[sorted.length - 1].start_date
    const range = first && last ? ` · ${formatRange(first, last)}` : ''
    return `${events.length} events${range}`
  }
  if (date_from && date_to) return formatRange(date_from, date_to)
  return 'Standalone story'
}
