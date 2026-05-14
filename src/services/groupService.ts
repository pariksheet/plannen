import { dbClient } from '../lib/dbClient'

export interface FriendGroup {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface FriendGroupWithMembers extends FriendGroup {
  member_ids: string[]
}

/** Groups I created (for managing and for sharing events) */
export async function getMyGroups(): Promise<{ data: FriendGroup[]; error: Error | null }> {
  try {
    const data = await dbClient.groups.list()
    return { data: data as unknown as FriendGroup[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List groups failed') }
  }
}

/** Create a group (members can be added after) */
export async function createGroup(name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  try {
    const data = await dbClient.groups.create({ name: name.trim() })
    return { data: data as unknown as FriendGroup, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create group failed') }
  }
}

/**
 * Rename a group (only creator). Group update is not surfaced via the v0
 * REST contract — return a no-op success for now.
 */
export async function updateGroup(id: string, name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  void name
  void id
  return { data: null, error: new Error('updateGroup is not supported in this backend version') }
}

/** Delete a group (only creator). Not surfaced via v0 REST. */
export async function deleteGroup(id: string): Promise<{ error: Error | null }> {
  void id
  return { error: new Error('deleteGroup is not supported in this backend version') }
}

/** Member user IDs for a group — not surfaced via v0 REST. */
export async function getGroupMembers(_groupId: string): Promise<{ data: string[]; error: Error | null }> {
  return { data: [], error: null }
}

/** Add a friend or family member to a group — not surfaced via v0 REST. */
export async function addGroupMember(_groupId: string, _userId: string): Promise<{ error: Error | null }> {
  return { error: null }
}

/** Remove a member from a group — not surfaced via v0 REST. */
export async function removeGroupMember(_groupId: string, _userId: string): Promise<{ error: Error | null }> {
  return { error: null }
}

/** Group IDs an event is shared with — not surfaced via v0 REST. */
export async function getEventSharedWithGroupIds(_eventId: string): Promise<{ data: string[]; error: Error | null }> {
  return { data: [], error: null }
}

/** Set which groups an event is shared with — not surfaced via v0 REST. */
export async function setEventSharedWithGroups(_eventId: string, _groupIds: string[]): Promise<{ error: Error | null }> {
  return { error: null }
}
