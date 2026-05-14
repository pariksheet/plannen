import { dbClient } from '../lib/dbClient'
import { Event, resolveEventStatus } from '../types/event'

// The v0 REST contract scopes /api/events to the current user (created_by =
// auth uid). Cross-user feeds (family / friends / groups) are NOT surfaced via
// REST yet — those views return empty for now. MyFeed returns events I created.

export async function getMyFeedEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  try {
    const created = await dbClient.events.list({ limit: 500 }) as unknown as Event[]
    const merged = created.map((e) => resolveEventStatus(e))
    return { data: enrichWithRecurrenceContext(merged), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get feed failed') }
  }
}

function enrichWithRecurrenceContext(events: Event[]): Event[] {
  const eventById = new Map(events.map((e) => [e.id, e]))
  const sessionsByParentId = new Map<string, Event[]>()
  for (const e of events) {
    if (e.parent_event_id) {
      if (!sessionsByParentId.has(e.parent_event_id)) sessionsByParentId.set(e.parent_event_id, [])
      sessionsByParentId.get(e.parent_event_id)!.push(e)
    }
  }
  const now = new Date()
  return events.map((e) => {
    if (e.parent_event_id) {
      const parent = eventById.get(e.parent_event_id)
      return { ...e, parent_title: parent?.title ?? null }
    }
    if (e.recurrence_rule) {
      const sessions = (sessionsByParentId.get(e.id) ?? []).sort(
        (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
      )
      const next = sessions.find((s) => new Date(s.start_date) >= now)
      return {
        ...e,
        sessions_summary: {
          total: sessions.length,
          past: sessions.filter((s) => s.event_status === 'past').length,
          missed: sessions.filter((s) => s.event_status === 'missed').length,
          next_date: next?.start_date ?? null,
        },
      }
    }
    return e
  })
}

export async function getFamilyEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  // Cross-user family-shared events are not exposed via v0 REST. Return [].
  return { data: [], error: null }
}

export async function getFriendsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  // Cross-user friend-shared events are not exposed via v0 REST. Return [].
  return { data: [], error: null }
}

/** Events visible via groups only — not exposed via v0 REST. */
export async function getGroupsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  return { data: [], error: null }
}
