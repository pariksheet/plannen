import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'

export async function createEventInvite(eventId: string): Promise<{ data: { token: string; expiresAt: string | null } | null; error: Error | null }> {
  try {
    const row = await dbClient.groups.createInvite({ event_id: eventId, expires_in_days: 7 })
    return {
      data: {
        token: row.token,
        expiresAt: row.expires_at ?? null,
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create invite failed') }
  }
}

export async function getInviteByToken(token: string): Promise<{
  data: { eventId: string; eventTitle: string } | null
  error: Error | null
}> {
  if (isTierZero()) {
    // Tier 0 is single-user — invite redemption is not exposed.
    return { data: null, error: null }
  }
  const trimmed = token.trim()
  if (!trimmed) return { data: null, error: null }
  const { data, error } = await supabase.rpc('get_invite_by_token', { invite_token: trimmed })
  if (error) return { data: null, error: new Error(error.message) }
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.event_id) return { data: null, error: null }
  return { data: { eventId: row.event_id, eventTitle: row.event_title ?? '' }, error: null }
}

export async function getOrCreateEventInvite(eventId: string): Promise<{ data: { token: string } | null; error: Error | null }> {
  try {
    const existing = await dbClient.groups.listInvites({ event_id: eventId })
    const nowIso = new Date().toISOString()
    const valid = existing.find((r) => !r.expires_at || r.expires_at > nowIso)
    if (valid) return { data: { token: valid.token }, error: null }
    const created = await createEventInvite(eventId)
    if (created.error || !created.data) return { data: null, error: created.error }
    return { data: { token: created.data.token }, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get/create invite failed') }
  }
}

/** Join the event as the current user using a valid invite token. */
export async function joinEventByInvite(token: string): Promise<{ data: { eventId: string } | null; error: Error | null }> {
  if (isTierZero()) {
    return { data: null, error: new Error('Invite redemption is not available in single-user mode.') }
  }
  const trimmed = token.trim()
  if (!trimmed) return { data: null, error: new Error('Invalid invite token') }
  const { data, error } = await supabase.rpc('join_event_by_invite', { invite_token: trimmed })
  if (error) return { data: null, error: new Error(error.message) }
  if (!data) return { data: null, error: new Error('Invalid or expired invite') }
  return { data: { eventId: data as string }, error: null }
}
