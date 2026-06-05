import { Event } from '../types/event'

export interface CalendarExportOptions {
  /** When set, use this as the event start (e.g. user's preferred visit date). End = start + event duration. */
  visitDate?: string | null
}

function getStartEnd(event: Event, visitDate?: string | null): { start: Date; end: Date } {
  const eventStart = new Date(event.start_date)
  const eventEnd = event.end_date ? new Date(event.end_date) : new Date(eventStart.getTime() + 60 * 60 * 1000)
  const durationMs = eventEnd.getTime() - eventStart.getTime()
  if (visitDate?.trim()) {
    const start = new Date(visitDate.trim())
    const end = new Date(start.getTime() + durationMs)
    return { start, end }
  }
  return { start: eventStart, end: eventEnd }
}

/** Escape text for iCal: backslash-escape semicolons, commas, backslashes, and newlines. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/** Format date for iCal (UTC): YYYYMMDDTHHMMSSZ */
function toIcsUtc(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const min = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${y}${m}${d}T${h}${min}${s}Z`
}

/**
 * Generate an iCalendar (.ics) string for a single event.
 * When options.visitDate is set, uses that as start and event duration for end.
 */
export function eventToIcs(event: Event, options?: CalendarExportOptions): string {
  const { start, end } = getStartEnd(event, options?.visitDate)
  const now = new Date()

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Plannen//Event//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:plannen-${event.id}@plannen`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ]

  let description = event.description?.trim() ?? ''
  if (event.enrollment_url?.trim()) {
    description = description ? `${description}\n\nEvent link: ${event.enrollment_url}` : `Event link: ${event.enrollment_url}`
  }
  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`)
  }
  if (event.location?.trim()) {
    lines.push(`LOCATION:${escapeIcsText(event.location.trim())}`)
  }

  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

/**
 * Trigger download of an .ics file for the given event.
 */
export function downloadIcs(event: Event, options?: CalendarExportOptions): void {
  const ics = eventToIcs(event, options)
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${event.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 50)}.ics`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Format date for Google Calendar URL: YYYYMMDDTHHMMSSZ (UTC) */
function toGoogleUtc(date: Date): string {
  return toIcsUtc(date)
}

/**
 * Build "Add to Google Calendar" URL for the event.
 * When options.visitDate is set, uses that as start and event duration for end.
 */
export function getGoogleCalendarAddUrl(event: Event, options?: CalendarExportOptions): string {
  const { start, end } = getStartEnd(event, options?.visitDate)
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toGoogleUtc(start)}/${toGoogleUtc(end)}`,
  })
  if (event.description?.trim()) {
    params.set('details', event.description.trim())
  }
  if (event.location?.trim()) {
    params.set('location', event.location.trim())
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** Format date for Outlook URL: YYYY-MM-DDTHH:mm:ssZ (UTC) */
function toOutlookUtc(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const min = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d}T${h}:${min}:${s}Z`
}

/**
 * Build "Add to Outlook Calendar" URL for the event.
 * When options.visitDate is set, uses that as start and event duration for end.
 */
export function getOutlookCalendarAddUrl(event: Event, options?: CalendarExportOptions): string {
  const { start, end } = getStartEnd(event, options?.visitDate)
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    startdt: toOutlookUtc(start),
    enddt: toOutlookUtc(end),
    subject: event.title,
  })
  if (event.description?.trim()) {
    params.set('body', event.description.trim())
  }
  if (event.location?.trim()) {
    params.set('location', event.location.trim())
  }
  return `https://outlook.office.com/calendar/deeplink/compose?${params.toString()}`
}
