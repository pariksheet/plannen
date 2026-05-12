import { supabase } from '../lib/supabase'

function generateToken(): string {
  const bytes = new Uint8Array(24)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function createEventInvite(eventId: string): Promise<{ data: { token: string; expiresAt: string | null } | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const token = generateToken()
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 7)
  const { error } = await supabase.from('event_invites').insert({
    event_id: eventId,
    token,
    created_by: user.id,
    expires_at: expiresAt.toISOString(),
  })
  if (error) return { data: null, error: new Error(error.message) }
  return { data: { token, expiresAt: expiresAt.toISOString() }, error: null }
}

export async function getInviteByToken(token: string): Promise<{
  data: { eventId: string; eventTitle: string } | null
  error: Error | null
}> {
  const trimmedToken = token?.trim() ?? ''
  if (!trimmedToken) return { data: null, error: null }
  const { data, error } = await supabase.rpc('get_invite_by_token', { invite_token: trimmedToken })
  if (error) return { data: null, error: new Error(error.message) }
  const rows = (data ?? []) as { event_id: string; event_title: string }[]
  const row = rows[0]
  if (!row) return { data: null, error: null }
  return { data: { eventId: row.event_id, eventTitle: row.event_title }, error: null }
}

export async function getOrCreateEventInvite(eventId: string): Promise<{ data: { token: string } | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data: existing } = await supabase
    .from('event_invites')
    .select('token')
    .eq('event_id', eventId)
    .eq('created_by', user.id)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle()
  if (existing && (existing as { token: string }).token) {
    return { data: { token: (existing as { token: string }).token }, error: null }
  }
  const { data: created, error } = await createEventInvite(eventId)
  if (error) return { data: null, error }
  return { data: created ? { token: created.token } : null, error: null }
}

/** Join the event as the current user using a valid invite token. */
export async function joinEventByInvite(token: string): Promise<{ data: { eventId: string } | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data: eventId, error } = await supabase.rpc('join_event_by_invite', { invite_token: token })
  if (error) return { data: null, error: new Error(error.message) }
  if (!eventId) return { data: null, error: new Error('Invalid or expired invite') }
  return { data: { eventId: eventId as string }, error: null }
}
