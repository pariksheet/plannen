import { format } from 'date-fns'
import type { Event } from '../types/event'
import type { Story } from '../types/story'
import { getPublicAppUrl } from './appUrl'

export interface WhatsAppShareOptions {
  /** When set, include "Visit: {date}" in the message (e.g. user's preferred visit date). */
  visitDate?: string | null
  /** When true, append a link to the app (if a non-localhost public URL is configured). Default true. */
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
    const publicUrl = getPublicAppUrl()
    if (publicUrl) {
      lines.push('')
      lines.push(`View in Plannen: ${publicUrl}`)
    }
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

const STORY_PREVIEW_CHARS = 220

/**
 * Build a short story summary for sharing on WhatsApp: title, first paragraph
 * preview, and a deep link to the story page in Plannen (only included when a
 * non-localhost public URL is configured).
 */
export function buildWhatsAppStoryMessage(story: Pick<Story, 'id' | 'title' | 'body'>): string {
  const lines: string[] = []
  lines.push(story.title.trim() || 'Story')

  const firstParagraph = story.body.split(/\n{2,}/).find((p) => p.trim().length > 0)?.trim() ?? ''
  if (firstParagraph) {
    const preview = firstParagraph.length > STORY_PREVIEW_CHARS
      ? `${firstParagraph.slice(0, STORY_PREVIEW_CHARS).trimEnd()}…`
      : firstParagraph
    lines.push('')
    lines.push(preview)
  }

  const publicUrl = getPublicAppUrl()
  if (publicUrl) {
    lines.push('')
    lines.push(`Read in Plannen: ${publicUrl}/stories/${story.id}`)
  }
  return lines.join('\n')
}

export function getWhatsAppStoryShareUrl(story: Pick<Story, 'id' | 'title' | 'body'>): string {
  const text = buildWhatsAppStoryMessage(story)
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}
