import { dbClient } from '../lib/dbClient'

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

export async function getInviteByToken(_token: string): Promise<{
  data: { eventId: string; eventTitle: string } | null
  error: Error | null
}> {
  // The original implementation used a Supabase RPC; no equivalent REST yet.
  // Return null (treated by callers as "no invite found").
  return { data: null, error: null }
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

/** Join the event as the current user using a valid invite token. Not surfaced via v0 REST. */
export async function joinEventByInvite(_token: string): Promise<{ data: { eventId: string } | null; error: Error | null }> {
  return { data: null, error: new Error('joinEventByInvite is not supported in this backend version') }
}
