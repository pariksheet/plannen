import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'
import { Event, resolveEventStatus } from '../types/event'
import { getAdoptedEventIds } from './shareService'

// The v0 REST contract scopes /api/events to the current user (created_by =
// auth uid). Cross-user feeds (people / groups) are not surfaced via REST yet
// — those views go through supabase-js directly when running Tier 1+.

export async function getMyFeedEvents(
  window?: { from_date?: string; to_date?: string },
): Promise<{ data: Event[] | null; error: Error | null }> {
  try {
    const params: { limit?: number; from_date?: string; to_date?: string } = {}
    if (window?.from_date) params.from_date = window.from_date
    if (window?.to_date) params.to_date = window.to_date
    // Windowed calls hit the backend's default LIMIT 50 ASC, which silently
    // drops events past the first 50 in the window — busy families easily
    // exceed that. Always ask for the 200-row cap. Unbounded fan-outs are
    // already protected by the 500-row legacy cap.
    params.limit = (!params.from_date && !params.to_date) ? 500 : 200
    const created = await dbClient.events.list(params) as unknown as Event[]
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

async function fetchEventsByIds(ids: string[]): Promise<Event[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('events').select('*').in('id', ids)
  if (error) throw new Error(error.message)
  return (data ?? []).map((e) => resolveEventStatus(e as Event))
}

/**
 * Given event ids that may include trip containers, return those ids plus the
 * ids of any child events/todos (group_id ∈ ids). The unified RLS already
 * permits SELECT of children whose container is shared with the caller — this
 * just discovers their ids so fetchEventsByIds surfaces them ("share once →
 * children follow").
 */
async function withTripChildren(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids
  const { data } = await supabase.from('events').select('id').in('group_id', ids)
  const childIds = (data ?? []).map((r) => r.id as string)
  return Array.from(new Set([...ids, ...childIds]))
}

/**
 * Events shared with any group I'm a member of OR a group I own. Tier 1+
 * only — Tier 0 has no cross-user sharing surface yet.
 */
export async function getGroupsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data: userRes } = await supabase.auth.getUser()
    const userId = userRes?.user?.id
    if (!userId) return { data: [], error: null }

    const [memberships, ownedGroups] = await Promise.all([
      supabase.from('friend_group_members').select('group_id').eq('user_id', userId),
      supabase.from('friend_groups').select('id').eq('created_by', userId),
    ])
    if (memberships.error) return { data: null, error: new Error(memberships.error.message) }
    if (ownedGroups.error) return { data: null, error: new Error(ownedGroups.error.message) }

    const accessibleGroupIds = Array.from(new Set([
      ...((memberships.data ?? []).map((r) => r.group_id as string)),
      ...((ownedGroups.data ?? []).map((r) => r.id as string)),
    ]))
    if (accessibleGroupIds.length === 0) return { data: [], error: null }

    const { data: shareRows, error: shareErr } = await supabase
      .from('event_shares')
      .select('event_id')
      .eq('target_type', 'group')
      .in('target_id', accessibleGroupIds)
    if (shareErr) return { data: null, error: new Error(shareErr.message) }

    const sharedIds = Array.from(new Set((shareRows ?? []).map((r) => r.event_id as string)))
    // Sharing a trip container surfaces its children too.
    const eventIds = await withTripChildren(sharedIds)
    const events = await fetchEventsByIds(eventIds)
    return { data: enrichWithRecurrenceContext(events), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get groups events failed') }
  }
}

/**
 * Events visible to me that I did NOT create, surfaced via direct personal
 * share or via shared_with_friends='all' from an accepted connection.
 *
 * After the family-as-group unification this powers the merged My People
 * tab. Events shared via groups are intentionally NOT included here — they
 * live in My Groups.
 */
async function getEventsSharedWithMeDirectly(): Promise<{ data: Event[] | null; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data: userRes } = await supabase.auth.getUser()
    const userId = userRes?.user?.id
    if (!userId) return { data: [], error: null }

    // Per-user + all-connections shares from event_shares. RLS on event_shares
    // already gates 'all' rows to accepted connections, so reading them is safe.
    const { data: shareRows, error: shareErr } = await supabase
      .from('event_shares')
      .select('event_id, target_type, target_id')
      .or(`and(target_type.eq.user,target_id.eq.${userId}),target_type.eq.all`)
    if (shareErr) return { data: null, error: new Error(shareErr.message) }
    const sharedIds = Array.from(new Set((shareRows ?? []).map((r) => r.event_id as string)))

    const eventIds = await withTripChildren(sharedIds)
    const events = await fetchEventsByIds(eventIds)
    // Hide events I created — they live in My Plans.
    return { data: enrichWithRecurrenceContext(events.filter((e) => e.created_by !== userId)), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get people events failed') }
  }
}

export async function getFamilyEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  // Merged into MyPeople after the family-as-group unification — the union of
  // family + friends is computed in MyPeople from this and getFriendsEvents.
  // Both helpers now return the same set; we keep both names for the existing
  // call sites until they collapse to a single getMyPeopleEvents().
  return getEventsSharedWithMeDirectly()
}

export async function getFriendsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  return getEventsSharedWithMeDirectly()
}

/**
 * The "Shared with me" inbox: events shared with me (directly, via a group, or
 * via 'all') that I have NOT yet adopted onto my own agenda. Awareness shares
 * sit here until the user opts in via shareService.adoptShare. Tier 1+ only.
 */
export async function getSharedWithMeInbox(): Promise<{ data: Event[] | null; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const [{ data: direct }, { data: groups }, { data: adoptedIds }] = await Promise.all([
      getEventsSharedWithMeDirectly(),
      getGroupsEvents(),
      getAdoptedEventIds(),
    ])
    const adopted = new Set(adoptedIds ?? [])
    const byId = new Map<string, Event>()
    for (const e of [...(direct ?? []), ...(groups ?? [])]) {
      if (!adopted.has(e.id)) byId.set(e.id, e)
    }
    return { data: enrichWithRecurrenceContext([...byId.values()]), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get shared-with-me inbox failed') }
  }
}
