import { dbClient } from '../lib/dbClient'
import type { Event, SharedWithFriends } from '../types/event'
import { setEventSharedWithGroups, setEventSharedWithUsers, getEventSharedWithGroupIds } from './groupService'
import { getEventSharedWithUserIds } from './eventService'
import { notifyEventShared } from '../lib/notify'

// Trip "containers" are ordinary events with event_kind='container'; member
// events/todos point at one via group_id. This wraps the tier-aware
// dbClient.events path (works in every tier), mirroring how the MCP creates a
// container and then attaches children.

export interface Trip {
  id: string
  title: string
  start_date: string
  end_date: string | null
}

export async function listContainers(): Promise<{ data: Trip[]; error: Error | null }> {
  try {
    const rows = (await dbClient.events.list({ limit: 200 })) as unknown as Event[]
    const trips = rows
      .filter((e) => e.event_kind === 'container')
      .map((e) => ({ id: e.id, title: e.title, start_date: e.start_date, end_date: e.end_date }))
    return { data: trips, error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List trips failed') }
  }
}

export async function createContainer(
  title: string,
  startIso?: string,
  endIso?: string | null,
): Promise<{ data: Trip | null; error: Error | null }> {
  const name = title.trim()
  if (!name) return { data: null, error: new Error('Trip name is required') }
  try {
    const me = await dbClient.me.get()
    const start = startIso || new Date().toISOString()
    const row = (await dbClient.events.create({
      title: name,
      start_date: start,
      end_date: endIso ?? null,
      event_kind: 'container',
      event_type: 'personal',
      event_status: new Date(start).getTime() < Date.now() ? 'past' : 'going',
      shared_with_friends: 'none',
      created_by: me.userId,
      group_id: null, // a container must not belong to another container
    })) as unknown as Event
    return { data: { id: row.id, title: row.title, start_date: row.start_date, end_date: row.end_date }, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create trip failed') }
  }
}

// Copy a trip's sharing onto a member event as its DEFAULT (a one-time
// snapshot, not a live lock — the user can change the event's sharing
// afterwards, and later trip changes won't re-apply unless re-synced).
async function applyTripSharingToEvent(eventId: string, containerId: string): Promise<void> {
  const container = (await dbClient.events.get(containerId)) as unknown as Event | null
  const friends = (container?.shared_with_friends as SharedWithFriends) ?? 'none'
  const { data: groupIds } = await getEventSharedWithGroupIds(containerId)
  const { data: userIds } = await getEventSharedWithUserIds(containerId)
  await dbClient.events.update(eventId, { shared_with_friends: friends } as Partial<Event>)
  await setEventSharedWithGroups(eventId, groupIds ?? [])
  await setEventSharedWithUsers(eventId, friends === 'selected' ? (userIds ?? []) : [])
  if ((groupIds?.length ?? 0) > 0 || (friends === 'selected' && (userIds?.length ?? 0) > 0)) {
    notifyEventShared(eventId, { group_ids: groupIds, user_ids: friends === 'selected' ? userIds : undefined })
  }
}

/** Attach an event/todo to a trip (or detach with null). On attach the event
 *  inherits the trip's sharing as its default — unless skipInherit is set
 *  (the user gave the event its own sharing, which must win). */
export async function assignToContainer(
  eventId: string,
  containerId: string | null,
  opts?: { skipInherit?: boolean },
): Promise<{ error: Error | null }> {
  try {
    await dbClient.events.update(eventId, { group_id: containerId } as Partial<Event>)
    if (containerId && !opts?.skipInherit) await applyTripSharingToEvent(eventId, containerId)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Assign trip failed') }
  }
}

/** Push a trip's current sharing onto all of its member events (the "share
 *  everything in this trip" action). */
export async function syncTripSharing(containerId: string, memberIds: string[]): Promise<{ count: number; error: Error | null }> {
  try {
    for (const id of memberIds) await applyTripSharingToEvent(id, containerId)
    return { count: memberIds.length, error: null }
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e : new Error('Sync trip sharing failed') }
  }
}

/** Delete a trip. Children detach automatically (group_id FK is ON DELETE SET NULL). */
export async function deleteContainer(id: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.events.delete(id)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete trip failed') }
  }
}
