import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'
import { notifyRsvp } from '../lib/notify'

export type RsvpStatus = 'going' | 'maybe' | 'not_going'

export interface MyRsvp {
  status: RsvpStatus | null
  preferred_visit_date: string | null
}

type RsvpRow = { event_id: string; user_id: string; status: string }
type VisitPrefRow = { event_id: string; user_id: string; visit_date: string | null }

async function fetchRsvpRows(eventIds: string[]): Promise<RsvpRow[]> {
  if (eventIds.length === 0) return []
  // Chunk so we stay under URL length / IN-list limits.
  const CHUNK = 500
  const out: RsvpRow[] = []
  try {
    for (let i = 0; i < eventIds.length; i += CHUNK) {
      const slice = eventIds.slice(i, i + CHUNK)
      if (isTierZero()) {
        // Tier 0: served by the embedded Node API at /api/rsvp.
        const params = new URLSearchParams({ event_ids: slice.join(',') })
        const res = await fetch(`/api/rsvp?${params}`, { headers: { 'Content-Type': 'application/json' } })
        if (!res.ok) continue
        const body = await res.json() as { data?: RsvpRow[] }
        if (Array.isArray(body.data)) out.push(...body.data)
      } else {
        // Tier 1 (Supabase): query event_rsvps directly. RLS limits results to
        // RSVPs on events the current user can see.
        const { data, error } = await supabase
          .from('event_rsvps')
          .select('event_id,user_id,status')
          .in('event_id', slice)
        if (error) continue
        if (data) out.push(...(data as RsvpRow[]))
      }
    }
    return out
  } catch {
    return out
  }
}

// Visit dates live in plannen.event_visit_preferences (issue #5), decoupled
// from RSVP status. dbClient.visitPreference.list is tier-aware, so both tiers
// share this fetch. RLS limits results to events the caller can see.
async function fetchVisitPrefRows(eventIds: string[]): Promise<VisitPrefRow[]> {
  if (eventIds.length === 0) return []
  const CHUNK = 500
  const out: VisitPrefRow[] = []
  try {
    for (let i = 0; i < eventIds.length; i += CHUNK) {
      const slice = eventIds.slice(i, i + CHUNK)
      const rows = await dbClient.visitPreference.list(slice)
      for (const r of rows) {
        out.push({ event_id: r.event_id, user_id: r.user_id, visit_date: r.visit_date ?? null })
      }
    }
    return out
  } catch {
    return out
  }
}

export async function getMyRsvp(eventId: string): Promise<{ data: MyRsvp | null; error: Error | null }> {
  try {
    const me = await dbClient.me.get()
    const [rsvps, prefs] = await Promise.all([
      fetchRsvpRows([eventId]),
      fetchVisitPrefRows([eventId]),
    ])
    const mineRsvp = rsvps.find((r) => r.user_id === me.userId)
    const minePref = prefs.find((r) => r.user_id === me.userId)
    return {
      data: {
        status: (mineRsvp?.status as RsvpStatus) ?? null,
        preferred_visit_date: minePref?.visit_date ?? null,
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get rsvp failed') }
  }
}

export async function setRsvp(eventId: string, status: RsvpStatus, preferred_visit_date?: string | null): Promise<{ error: Error | null }> {
  try {
    await dbClient.rsvp.upsert({ event_id: eventId, status })
    // A visit date passed alongside an RSVP is still just a planning hint — it
    // is stored separately and never gates the RSVP itself.
    if (preferred_visit_date !== undefined) {
      await dbClient.visitPreference.upsert({ event_id: eventId, visit_date: preferred_visit_date || null })
    }
    notifyRsvp(eventId, status)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Set rsvp failed') }
  }
}

export async function setPreferredVisitDate(eventId: string, date: string | null): Promise<{ error: Error | null }> {
  // Visit date is decoupled from RSVP status (issue #5): setting it never
  // creates or mutates an RSVP, and it can be set with no RSVP at all.
  try {
    await dbClient.visitPreference.upsert({ event_id: eventId, visit_date: date || null })
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Set preferred visit date failed') }
  }
}

/** Fetch preferred_visit_date for a specific user — best-effort across the v0 REST. */
export async function getPreferredVisitDateForUser(
  eventId: string,
  userId: string,
): Promise<{ data: string | null; error: Error | null }> {
  try {
    const rows = await fetchVisitPrefRows([eventId])
    const row = rows.find((r) => r.user_id === userId)
    return { data: row?.visit_date ?? null, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get preferred visit date failed') }
  }
}

/** Fetch current user's preferred_visit_date for many events. */
export async function getPreferredVisitDates(
  eventIds: string[],
): Promise<{ data: Record<string, string | null>; error: Error | null }> {
  if (eventIds.length === 0) return { data: {}, error: null }
  try {
    const me = await dbClient.me.get()
    const rows = await fetchVisitPrefRows(eventIds)
    const map: Record<string, string | null> = {}
    rows.filter((r) => r.user_id === me.userId).forEach((r) => {
      map[r.event_id] = r.visit_date ?? null
    })
    return { data: map, error: null }
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e : new Error('Get preferred visit dates failed') }
  }
}

/** Fetch creators' preferred_visit_date for events. */
export async function getCreatorPreferredVisitDates(
  events: { id: string; created_by: string }[],
): Promise<{ data: Record<string, string | null>; error: Error | null }> {
  if (events.length === 0) return { data: {}, error: null }
  try {
    const me = await dbClient.me.get()
    const eventIds = events.filter((e) => e.created_by !== me.userId).map((e) => e.id)
    if (eventIds.length === 0) return { data: {}, error: null }
    const rows = await fetchVisitPrefRows(eventIds)
    const createdBy = new Map(events.map((e) => [e.id, e.created_by]))
    const map: Record<string, string | null> = {}
    rows.forEach((r) => {
      if (createdBy.get(r.event_id) === r.user_id && r.visit_date) {
        map[r.event_id] = r.visit_date
      }
    })
    return { data: map, error: null }
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e : new Error('Get creator visit dates failed') }
  }
}

type RsvpUser = { id: string; email?: string; full_name?: string }
type RsvpBuckets = { going: RsvpUser[]; maybe: RsvpUser[]; not_going: RsvpUser[] }

export async function getRsvpList(eventId: string): Promise<{
  data: RsvpBuckets | null
  error: Error | null
}> {
  const empty: RsvpBuckets = { going: [], maybe: [], not_going: [] }
  // Tier 0 is single-user — there's no roster of other people to list.
  if (isTierZero()) return { data: empty, error: null }
  try {
    const rows = await fetchRsvpRows([eventId])
    if (rows.length === 0) return { data: empty, error: null }
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)))
    // Hydrate display names (RLS-scoped; degrades to id-only when not readable).
    const { data: users } = await supabase
      .from('users')
      .select('id, email, full_name')
      .in('id', userIds)
    const byId = new Map((users ?? []).map((u) => [u.id as string, u as { email?: string; full_name?: string }]))
    const buckets: RsvpBuckets = { going: [], maybe: [], not_going: [] }
    for (const r of rows) {
      const u = byId.get(r.user_id)
      const entry: RsvpUser = { id: r.user_id, email: u?.email ?? undefined, full_name: u?.full_name ?? undefined }
      if (r.status === 'going') buckets.going.push(entry)
      else if (r.status === 'maybe') buckets.maybe.push(entry)
      else if (r.status === 'not_going') buckets.not_going.push(entry)
    }
    return { data: buckets, error: null }
  } catch (e) {
    return { data: empty, error: e instanceof Error ? e : new Error('Get rsvp list failed') }
  }
}
