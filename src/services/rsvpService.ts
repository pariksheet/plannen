import { dbClient } from '../lib/dbClient'

export type RsvpStatus = 'going' | 'maybe' | 'not_going'

export interface MyRsvp {
  status: RsvpStatus | null
  preferred_visit_date: string | null
}

async function fetchRsvpRows(eventIds: string[]): Promise<Array<{ event_id: string; user_id: string; status: string; preferred_visit_date: string | null }>> {
  // The v0 REST contract exposes a single-event GET only. Fan out per id.
  const out: Array<{ event_id: string; user_id: string; status: string; preferred_visit_date: string | null }> = []
  await Promise.all(
    eventIds.map(async (id) => {
      try {
        const params = new URLSearchParams({ event_id: id })
        const res = await fetch(`/api/rsvp?${params}`, { headers: { 'Content-Type': 'application/json' } })
        if (!res.ok) return
        const body = await res.json() as { data?: { event_id: string; user_id: string; status: string; preferred_visit_date: string | null } | null }
        if (body.data) out.push(body.data)
      } catch { /* ignore */ }
    }),
  )
  return out
}

export async function getMyRsvp(eventId: string): Promise<{ data: MyRsvp | null; error: Error | null }> {
  try {
    const me = await dbClient.me.get()
    const rows = await fetchRsvpRows([eventId])
    const mine = rows.find((r) => r.user_id === me.userId)
    if (!mine) return { data: { status: null, preferred_visit_date: null }, error: null }
    return {
      data: {
        status: (mine.status as RsvpStatus) ?? null,
        preferred_visit_date: mine.preferred_visit_date ?? null,
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get rsvp failed') }
  }
}

export async function setRsvp(eventId: string, status: RsvpStatus, preferred_visit_date?: string | null): Promise<{ error: Error | null }> {
  try {
    await dbClient.rsvp.upsert({
      event_id: eventId,
      status,
      ...(preferred_visit_date !== undefined ? { preferred_visit_date: preferred_visit_date || null } : {}),
    })
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Set rsvp failed') }
  }
}

export async function setPreferredVisitDate(eventId: string, date: string | null): Promise<{ error: Error | null }> {
  const { data, error: fetchErr } = await getMyRsvp(eventId)
  if (fetchErr) return { error: fetchErr }
  const currentStatus = data?.status ?? 'maybe'
  return setRsvp(eventId, currentStatus as RsvpStatus, date)
}

/** Fetch preferred_visit_date for a specific user's RSVP — best-effort across the v0 REST. */
export async function getPreferredVisitDateForUser(
  eventId: string,
  userId: string,
): Promise<{ data: string | null; error: Error | null }> {
  try {
    const rows = await fetchRsvpRows([eventId])
    const row = rows.find((r) => r.user_id === userId)
    return { data: row?.preferred_visit_date ?? null, error: null }
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
    const rows = await fetchRsvpRows(eventIds)
    const map: Record<string, string | null> = {}
    rows.filter((r) => r.user_id === me.userId).forEach((r) => {
      map[r.event_id] = r.preferred_visit_date ?? null
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
    const rows = await fetchRsvpRows(eventIds)
    const createdBy = new Map(events.map((e) => [e.id, e.created_by]))
    const map: Record<string, string | null> = {}
    rows.forEach((r) => {
      if (createdBy.get(r.event_id) === r.user_id && r.preferred_visit_date) {
        map[r.event_id] = r.preferred_visit_date
      }
    })
    return { data: map, error: null }
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e : new Error('Get creator visit dates failed') }
  }
}

export async function getRsvpList(_eventId: string): Promise<{
  data: { going: { id: string; email?: string; full_name?: string }[]; maybe: { id: string; email?: string; full_name?: string }[]; not_going: { id: string; email?: string; full_name?: string }[] } | null
  error: Error | null
}> {
  // Listing all RSVPs for an event with joined user details is not surfaced
  // by the v0 REST contract — return an empty bucket structure.
  return { data: { going: [], maybe: [], not_going: [] }, error: null }
}
