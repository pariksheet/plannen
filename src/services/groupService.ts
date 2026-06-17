import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'

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

/** Create a group (members can be added after). Auto-promotes the new group
 *  to "primary" when the user doesn't have one set — the common case is the
 *  user's first group. Tier 0 skips the promotion (no primary concept). */
export async function createGroup(name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  try {
    const data = await dbClient.groups.create({ name: name.trim() })
    const group = data as unknown as FriendGroup
    if (!isTierZero()) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: row } = await supabase
          .from('users')
          .select('primary_group_id')
          .eq('id', user.id)
          .maybeSingle()
        if (row && (row as { primary_group_id: string | null }).primary_group_id == null) {
          // Best-effort: failure here doesn't roll back the create.
          await supabase.from('users').update({ primary_group_id: group.id }).eq('id', user.id)
        }
      }
    }
    return { data: group, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create group failed') }
  }
}

/** Pin (or clear) a group as the user's primary. Tier 1+ writes
 *  plannen.users.primary_group_id; Tier 0 is a no-op (groups are hidden). */
export async function setPrimaryGroupId(groupId: string | null): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: new Error('Not authenticated') }
    const { error } = await supabase
      .from('users')
      .update({ primary_group_id: groupId })
      .eq('id', user.id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('setPrimaryGroupId failed') }
  }
}

/**
 * Rename a group (only creator). Tier 1+ updates plannen.friend_groups
 * directly via supabase-js (RLS limits the row to the creator). Tier 0 has
 * no group concept.
 */
export async function updateGroup(id: string, name: string): Promise<{ data: FriendGroup | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error('Groups are not available in single-user mode.') }
  try {
    const { data, error } = await supabase
      .from('friend_groups')
      .update({ name: name.trim() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return { data: data as unknown as FriendGroup, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Rename group failed') }
  }
}

/** Delete a group (only creator). Members and event/story share rows cascade
 *  on the friend_groups FK. Clears the user's primary pointer first if it
 *  references this group. Tier 1+ only. */
export async function deleteGroup(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error('Groups are not available in single-user mode.') }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      // Best-effort: drop a dangling primary_group_id before the delete.
      await supabase.from('users').update({ primary_group_id: null }).eq('id', user.id).eq('primary_group_id', id)
    }
    const { error } = await supabase.from('friend_groups').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete group failed') }
  }
}

/** Member user IDs for a group. Tier-1 reads friend_group_members via supabase-js. */
export async function getGroupMembers(groupId: string): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('friend_group_members')
      .select('user_id')
      .eq('group_id', groupId)
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.user_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getGroupMembers failed') }
  }
}

/** Add a contact to a group. Tier-1 writes friend_group_members via supabase-js. */
export async function addGroupMember(groupId: string, userId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { error } = await supabase
      .from('friend_group_members')
      .insert({ group_id: groupId, user_id: userId })
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('addGroupMember failed') }
  }
}

/** Remove a contact from a group. Tier-1 deletes friend_group_members via supabase-js. */
export async function removeGroupMember(groupId: string, userId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { error } = await supabase
      .from('friend_group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('removeGroupMember failed') }
  }
}

/** Group IDs an event is shared with. Reads the unified event_shares table. */
export async function getEventSharedWithGroupIds(eventId: string): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('event_shares')
      .select('target_id')
      .eq('event_id', eventId)
      .eq('target_type', 'group')
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.target_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getEventSharedWithGroupIds failed') }
  }
}

// Event group/user sharing now lives in the unified event_shares table — see
// shareService (setShares/addShare/removeShare). The legacy
// setEventSharedWith{Groups,Users} writers were removed with migration
// 20260617170000, which dropped the junction tables.

/** Group IDs a story is shared with. Tier-1 reads story_shared_with_groups via supabase-js. */
export async function getStorySharedWithGroupIds(storyId: string): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('story_shared_with_groups')
      .select('group_id')
      .eq('story_id', storyId)
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.group_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getStorySharedWithGroupIds failed') }
  }
}

/** Set which groups a story is shared with. Tier-1 writes story_shared_with_groups via supabase-js. */
export async function setStorySharedWithGroups(storyId: string, groupIds: string[]): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { error: delErr } = await supabase
      .from('story_shared_with_groups')
      .delete()
      .eq('story_id', storyId)
    if (delErr) throw new Error(delErr.message)
    if (groupIds.length === 0) return { error: null }
    const rows = groupIds.map((group_id) => ({ story_id: storyId, group_id }))
    const { error: insErr } = await supabase.from('story_shared_with_groups').insert(rows)
    if (insErr) throw new Error(insErr.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('setStorySharedWithGroups failed') }
  }
}

/** User IDs a story is shared with directly. Mirrors event_shared_with_users. */
export async function getStorySharedWithUserIds(storyId: string): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('story_shared_with_users')
      .select('user_id')
      .eq('story_id', storyId)
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.user_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getStorySharedWithUserIds failed') }
  }
}

/** Set which users a story is shared with directly. */
export async function setStorySharedWithUsers(storyId: string, userIds: string[]): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { error: delErr } = await supabase
      .from('story_shared_with_users')
      .delete()
      .eq('story_id', storyId)
    if (delErr) throw new Error(delErr.message)
    if (userIds.length === 0) return { error: null }
    const rows = userIds.map((user_id) => ({ story_id: storyId, user_id }))
    const { error: insErr } = await supabase.from('story_shared_with_users').insert(rows)
    if (insErr) throw new Error(insErr.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('setStorySharedWithUsers failed') }
  }
}
