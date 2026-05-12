import { supabase } from '../lib/supabase'

export type RsvpStatus = 'going' | 'maybe' | 'not_going'

export interface MyRsvp {
  status: RsvpStatus | null
  preferred_visit_date: string | null
}

export async function getMyRsvp(eventId: string): Promise<{ data: MyRsvp | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('event_rsvps')
    .select('status, preferred_visit_date')
    .eq('event_id', eventId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return { data: null, error: new Error(error.message) }
  if (!data) return { data: { status: null, preferred_visit_date: null }, error: null }
  return {
    data: {
      status: (data.status as RsvpStatus) ?? null,
      preferred_visit_date: data.preferred_visit_date ?? null,
    },
    error: null,
  }
}

export async function setRsvp(eventId: string, status: RsvpStatus, preferred_visit_date?: string | null): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const row: { event_id: string; user_id: string; status: RsvpStatus; preferred_visit_date?: string | null } = {
    event_id: eventId,
    user_id: user.id,
    status,
  }
  if (preferred_visit_date !== undefined) row.preferred_visit_date = preferred_visit_date || null
  const { error } = await supabase.from('event_rsvps').upsert(row, { onConflict: 'event_id,user_id' })
  return { error: error ? new Error(error.message) : null }
}

export async function setPreferredVisitDate(eventId: string, date: string | null): Promise<{ error: Error | null }> {
  const { data, error: fetchErr } = await getMyRsvp(eventId)
  if (fetchErr) return { error: fetchErr }
  const currentStatus = data?.status ?? 'maybe'
  return setRsvp(eventId, currentStatus as RsvpStatus, date)
}

/** Fetch preferred_visit_date for a specific user's RSVP (e.g. organiser's date so everyone sees the same "Visit" on the card). */
export async function getPreferredVisitDateForUser(
  eventId: string,
  userId: string
): Promise<{ data: string | null; error: Error | null }> {
  const { data, error } = await supabase
    .from('event_rsvps')
    .select('preferred_visit_date')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data?.preferred_visit_date ?? null, error: null }
}

/** Fetch current user's preferred_visit_date for many events (for timeline/sorting). */
export async function getPreferredVisitDates(
  eventIds: string[]
): Promise<{ data: Record<string, string | null>; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || eventIds.length === 0) return { data: {}, error: null }
  const { data, error } = await supabase
    .from('event_rsvps')
    .select('event_id, preferred_visit_date')
    .eq('user_id', user.id)
    .in('event_id', eventIds)
  if (error) return { data: {}, error: new Error(error.message) }
  const map: Record<string, string | null> = {}
  ;(data ?? []).forEach((r: { event_id: string; preferred_visit_date: string | null }) => {
    map[r.event_id] = r.preferred_visit_date ?? null
  })
  return { data: map, error: null }
}

/** Fetch creators' preferred_visit_date for events (for calendar: show event on creator's visit day when viewer has none). */
export async function getCreatorPreferredVisitDates(
  events: { id: string; created_by: string }[]
): Promise<{ data: Record<string, string | null>; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || events.length === 0) return { data: {}, error: null }
  const eventIds = events.filter((e) => e.created_by !== user.id).map((e) => e.id)
  if (eventIds.length === 0) return { data: {}, error: null }
  const { data, error } = await supabase
    .from('event_rsvps')
    .select('event_id, user_id, preferred_visit_date')
    .in('event_id', eventIds)
  if (error) return { data: {}, error: new Error(error.message) }
  const byEvent = new Map<string, string | null>()
  const createdBy = new Map(events.map((e) => [e.id, e.created_by]))
  ;(data ?? []).forEach((r: { event_id: string; user_id: string; preferred_visit_date: string | null }) => {
    if (createdBy.get(r.event_id) === r.user_id && r.preferred_visit_date) {
      byEvent.set(r.event_id, r.preferred_visit_date)
    }
  })
  const map: Record<string, string | null> = {}
  byEvent.forEach((v, k) => { map[k] = v })
  return { data: map, error: null }
}

export async function getRsvpList(eventId: string): Promise<{
  data: { going: { id: string; email?: string; full_name?: string }[]; maybe: { id: string; email?: string; full_name?: string }[]; not_going: { id: string; email?: string; full_name?: string }[] } | null
  error: Error | null
}> {
  const { data, error } = await supabase
    .from('event_rsvps')
    .select('status, users(id, email, full_name)')
    .eq('event_id', eventId)
  if (error) return { data: null, error: new Error(error.message) }
  const going: { id: string; email?: string; full_name?: string }[] = []
  const maybe: typeof going = []
  const not_going: typeof going = []
  ;(data ?? []).forEach((r: { status: string; users: { id: string; email?: string; full_name?: string } | { id: string; email?: string; full_name?: string }[] | null }) => {
    const raw = r.users
    const u = Array.isArray(raw) ? raw[0] : raw
    const user = u ?? { id: '' }
    if (r.status === 'going') going.push(user)
    else if (r.status === 'maybe') maybe.push(user)
    else not_going.push(user)
  })
  return { data: { going, maybe, not_going }, error: null }
}
