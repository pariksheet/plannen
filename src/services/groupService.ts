import { supabase } from '../lib/supabase'

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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('friend_groups')
    .select('*')
    .eq('created_by', user.id)
    .order('name')
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as FriendGroup[], error: null }
}

/** Create a group (members can be added after) */
export async function createGroup(name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('friend_groups')
    .insert({ name: name.trim(), created_by: user.id })
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as FriendGroup, error: null }
}

/** Rename a group (only creator) */
export async function updateGroup(id: string, name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('friend_groups')
    .update({ name: name.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('created_by', user.id)
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as FriendGroup, error: null }
}

/** Delete a group (only creator). Events shared with this group are unchanged; they simply stop being shared with this group. */
export async function deleteGroup(id: string): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('friend_groups')
    .delete()
    .eq('id', id)
    .eq('created_by', user.id)
  return { error: error ? new Error(error.message) : null }
}

/** Member user IDs for a group (only for groups I own or am in) */
export async function getGroupMembers(groupId: string): Promise<{ data: string[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('friend_group_members')
    .select('user_id')
    .eq('group_id', groupId)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []).map((r: { user_id: string }) => r.user_id), error: null }
}

/** Add a friend or family member to a group (only group creator). Idempotent: safe if already a member. */
export async function addGroupMember(groupId: string, userId: string): Promise<{ error: Error | null }> {
  if (!groupId || !userId) return { error: new Error('group_id and user_id are required') }
  const { error } = await supabase
    .from('friend_group_members')
    .insert({ group_id: groupId, user_id: userId })
  if (error) {
    const isDuplicate = error.code === '23505' || /duplicate key|already exists/i.test(error.message)
    if (isDuplicate) return { error: null }
    return { error: new Error(error.message) }
  }
  return { error: null }
}

/** Remove a member from a group (only group creator) */
export async function removeGroupMember(groupId: string, userId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from('friend_group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', userId)
  return { error: error ? new Error(error.message) : null }
}

/** Group IDs an event is shared with */
export async function getEventSharedWithGroupIds(eventId: string): Promise<{ data: string[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('event_shared_with_groups')
    .select('group_id')
    .eq('event_id', eventId)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []).map((r: { group_id: string }) => r.group_id), error: null }
}

/** Set which groups an event is shared with (replaces existing). Caller must be event creator. */
export async function setEventSharedWithGroups(eventId: string, groupIds: string[]): Promise<{ error: Error | null }> {
  const { error: delErr } = await supabase
    .from('event_shared_with_groups')
    .delete()
    .eq('event_id', eventId)
  if (delErr) return { error: new Error(delErr.message) }
  if (groupIds.length > 0) {
    const { error: insErr } = await supabase
      .from('event_shared_with_groups')
      .insert(groupIds.map((group_id) => ({ event_id: eventId, group_id })))
    if (insErr) return { error: new Error(insErr.message) }
  }
  return { error: null }
}
