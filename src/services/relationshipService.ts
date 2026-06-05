import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'

export interface FriendUser {
  id: string
  email: string | null
  full_name: string | null
}

export interface RelationshipRequest {
  id: string
  direction: 'sent' | 'received'
  other_user_id: string
  other_email: string | null
  other_name: string | null
  created_at: string
}

export async function getAcceptedRelatedUserIds(): Promise<{ data: string[]; error: Error | null }> {
  try {
    const me = await dbClient.me.get()
    const rows = await dbClient.relationships.listRelationships()
    const accepted = rows.filter((r) => r.status === 'accepted')
    const ids = new Set<string>()
    accepted.forEach((r) => {
      ids.add(r.user_id as string)
      ids.add(r.related_user_id as string)
    })
    ids.delete(me.userId)
    return { data: Array.from(ids), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List relationships failed') }
  }
}

async function hydrateUsers(ids: string[]): Promise<FriendUser[]> {
  if (ids.length === 0) return []
  if (isTierZero()) return ids.map((id) => ({ id, email: null, full_name: null }))
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .in('id', ids)
  if (error) return ids.map((id) => ({ id, email: null, full_name: null }))
  const byId = new Map((data ?? []).map((u) => [u.id as string, u as FriendUser]))
  return ids.map((id) => byId.get(id) ?? { id, email: null, full_name: null })
}

/** All accepted connections. The family/friend distinction was removed in
 *  the family-as-group unification — every accepted relationship is now
 *  just a connection. */
export async function getMyConnections(): Promise<{ data: FriendUser[]; error: Error | null }> {
  const { data: ids, error } = await getAcceptedRelatedUserIds()
  if (error) return { data: [], error }
  return { data: await hydrateUsers(ids), error: null }
}

const TIER0_UNSUPPORTED = 'Relationship requests are not available in single-user mode.'

export async function sendRelationshipRequest(
  email: string,
): Promise<{ data: string | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_UNSUPPORTED) }
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return { data: null, error: new Error('Email is required') }
  const { data, error } = await supabase.rpc('send_relationship_request', {
    target_email: trimmed,
  })
  if (error) return { data: null, error: new Error(error.message) }
  return { data: (data as string | null) ?? null, error: null }
}

export async function getRelationshipRequests(): Promise<{ data: RelationshipRequest[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  const { data, error } = await supabase.rpc('get_relationship_requests')
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as RelationshipRequest[], error: null }
}

export async function acceptRelationshipRequest(relId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_UNSUPPORTED) }
  const { error } = await supabase.rpc('accept_relationship', { rel_id: relId })
  if (error) return { error: new Error(error.message) }
  return { error: null }
}

export async function declineRelationshipRequest(relId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_UNSUPPORTED) }
  const { error } = await supabase.rpc('decline_relationship', { rel_id: relId })
  if (error) return { error: new Error(error.message) }
  return { error: null }
}
