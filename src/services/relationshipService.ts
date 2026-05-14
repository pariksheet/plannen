import { dbClient } from '../lib/dbClient'

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
  try {
    const me = await dbClient.me.get()
    const rows = await dbClient.relationships.listRelationships()
    const accepted = rows.filter((r) =>
      r.status === 'accepted' &&
      types.includes((r.relationship_type as 'friend' | 'family' | 'both'))
    )
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

/** Friends — in v0 REST there is no users-by-id endpoint, so we return only IDs (no email/full_name). */
export async function getMyFriends(): Promise<{ data: FriendUser[]; error: Error | null }> {
  const { data: ids, error } = await getAcceptedRelatedUserIds(['friend', 'both'])
  if (error) return { data: [], error }
  return { data: ids.map((id) => ({ id, email: null, full_name: null })), error: null }
}

/** Family members — same caveat as getMyFriends. */
export async function getMyFamily(): Promise<{ data: FriendUser[]; error: Error | null }> {
  const { data: ids, error } = await getAcceptedRelatedUserIds(['family', 'both'])
  if (error) return { data: [], error }
  return { data: ids.map((id) => ({ id, email: null, full_name: null })), error: null }
}

/** Send a request — backed by an RPC in Tier 1; not surfaced via v0 REST. */
export async function sendRelationshipRequest(
  _email: string,
  _relationshipType: 'friend' | 'family' | 'both'
): Promise<{ data: string | null; error: Error | null }> {
  return { data: null, error: new Error('sendRelationshipRequest is not supported in this backend version') }
}

/** Pending requests — backed by an RPC in Tier 1; not surfaced via v0 REST. */
export async function getRelationshipRequests(): Promise<{ data: RelationshipRequest[]; error: Error | null }> {
  return { data: [], error: null }
}

export async function acceptRelationshipRequest(_relId: string): Promise<{ error: Error | null }> {
  return { error: new Error('acceptRelationshipRequest is not supported in this backend version') }
}

export async function declineRelationshipRequest(_relId: string): Promise<{ error: Error | null }> {
  return { error: new Error('declineRelationshipRequest is not supported in this backend version') }
}
