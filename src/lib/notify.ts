// Thin client for the `notify` server-side push fan-out. Fire-and-forget
// from the call sites that write shares/RSVPs via supabase-js — the server
// resolves recipients, looks up the sender's display name, and sends push
// to anyone subscribed.

import { supabase } from './supabase'
import { isTierZero } from './tier'

type NotifyBody =
  | { kind: 'rsvp'; event_id: string; status: 'going' | 'maybe' | 'not_going' }
  | { kind: 'event_shared'; event_id: string; group_ids?: string[]; user_ids?: string[] }
  | { kind: 'story_shared'; story_id: string; group_ids?: string[]; user_ids?: string[] }

async function postNotify(body: NotifyBody): Promise<void> {
  try {
    if (isTierZero()) {
      await fetch('/functions/v1/notify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return
    }
    await supabase.functions.invoke('notify', { method: 'POST', body })
  } catch {
    // Notifications are best-effort — never block the calling action.
  }
}

export function notifyRsvp(eventId: string, status: 'going' | 'maybe' | 'not_going'): void {
  void postNotify({ kind: 'rsvp', event_id: eventId, status })
}

export function notifyEventShared(
  eventId: string,
  recipients: { group_ids?: string[]; user_ids?: string[] },
): void {
  const groups = recipients.group_ids ?? []
  const users = recipients.user_ids ?? []
  if (groups.length === 0 && users.length === 0) return
  void postNotify({ kind: 'event_shared', event_id: eventId, group_ids: groups, user_ids: users })
}

export function notifyStoryShared(
  storyId: string,
  recipients: { group_ids?: string[]; user_ids?: string[] },
): void {
  const groups = recipients.group_ids ?? []
  const users = recipients.user_ids ?? []
  if (groups.length === 0 && users.length === 0) return
  void postNotify({ kind: 'story_shared', story_id: storyId, group_ids: groups, user_ids: users })
}
