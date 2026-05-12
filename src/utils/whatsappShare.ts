import { format } from 'date-fns'
import type { Event } from '../types/event'

const APP_URL = (import.meta.env.VITE_APP_URL as string | undefined) ?? 'http://localhost:4321'

export interface WhatsAppShareOptions {
  /** When set, include "Visit: {date}" in the message (e.g. user's preferred visit date). */
  visitDate?: string | null
  /** When true, append a link to the app. Default true. */
  includeAppLink?: boolean
}

/**
 * Build a short event summary for sharing (e.g. WhatsApp).
 * Includes title, date/time, optional visit date, location, and optional app link.
 */
export function buildWhatsAppEventMessage(event: Event, options?: WhatsAppShareOptions): string {
  const lines: string[] = []
  lines.push(event.title.trim() || 'Event')

  const start = new Date(event.start_date)
  const end = event.end_date ? new Date(event.end_date) : null
  const dateStr = end && end.getTime() > start.getTime()
    ? `${format(start, 'MMM d, yyyy, h:mm a')} – ${format(end, 'MMM d, yyyy, h:mm a')}`
    : format(start, 'MMM d, yyyy, h:mm a')
  lines.push(`📅 ${dateStr}`)

  if (options?.visitDate?.trim()) {
    lines.push(`Visit: ${format(new Date(options.visitDate.trim()), 'MMM d, yyyy h:mm a')}`)
  }

  if (event.location?.trim()) {
    lines.push(`📍 ${event.location.trim()}`)
  }

  if (options?.includeAppLink !== false) {
    lines.push('')
    lines.push(`View in Plannen: ${APP_URL}`)
  }

  return lines.join('\n')
}

/**
 * Return the WhatsApp share URL (wa.me) with the event message as pre-filled text.
 */
export function getWhatsAppShareUrl(event: Event, options?: WhatsAppShareOptions): string {
  const text = buildWhatsAppEventMessage(event, options)
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}
