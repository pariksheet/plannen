import { supabase } from '../lib/supabase'

export interface FriendUser {
  id: string
  email: string | null
  full_name: string | null
}

export interface RelationshipRequest {
  id: string
  direction: 'sent' | 'received'
  relationship_type: 'friend' | 'family' | 'both'
  other_user_id: string
  other_email: string | null
  other_name: string | null
  created_at: string
}

export async function getAcceptedRelatedUserIds(types: ('friend' | 'family' | 'both')[]): Promise<{ data: string[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('relationships')
    .select('user_id, related_user_id, relationship_type')
    .or(`user_id.eq.${user.id},related_user_id.eq.${user.id}`)
    .eq('status', 'accepted')
    .in('relationship_type', types)
  if (error) return { data: [], error: new Error(error.message) }
  const ids = new Set<string>()
  ;(data ?? []).forEach((r: { user_id: string; related_user_id: string }) => {
    ids.add(r.user_id)
    ids.add(r.related_user_id)
  })
  ids.delete(user.id)
  return { data: Array.from(ids), error: null }
}

/** Friends (and "both") with user details for share picker */
export async function getMyFriends(): Promise<{ data: FriendUser[]; error: Error | null }> {
  const { data: ids, error: idsError } = await getAcceptedRelatedUserIds(['friend', 'both'])
  if (idsError || !ids.length) return { data: [], error: idsError ?? null }
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .in('id', ids)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as FriendUser[], error: null }
}

/** Family members (and "both") with user details */
export async function getMyFamily(): Promise<{ data: FriendUser[]; error: Error | null }> {
  const { data: ids, error: idsError } = await getAcceptedRelatedUserIds(['family', 'both'])
  if (idsError || !ids.length) return { data: [], error: idsError ?? null }
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .in('id', ids)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as FriendUser[], error: null }
}

/** Send a family or friend request by email. They must already have an account. */
export async function sendRelationshipRequest(
  email: string,
  relationshipType: 'friend' | 'family' | 'both'
): Promise<{ data: string | null; error: Error | null }> {
  const { data, error } = await supabase.rpc('send_relationship_request', {
    target_email: email.trim(),
    rel_type: relationshipType,
  })
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as string, error: null }
}

/** Pending requests (received and sent) with other user info */
export async function getRelationshipRequests(): Promise<{ data: RelationshipRequest[]; error: Error | null }> {
  const { data, error } = await supabase.rpc('get_relationship_requests')
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as RelationshipRequest[], error: null }
}

export async function acceptRelationshipRequest(relId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase.rpc('accept_relationship', { rel_id: relId })
  return { error: error ? new Error(error.message) : null }
}

export async function declineRelationshipRequest(relId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase.rpc('decline_relationship', { rel_id: relId })
  return { error: error ? new Error(error.message) : null }
}
