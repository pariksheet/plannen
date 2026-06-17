import { dbClient } from '../lib/dbClient'
import type { Event } from '../types/event'

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
      created_by: me.userId,
      group_id: null, // a container must not belong to another container
    })) as unknown as Event
    return { data: { id: row.id, title: row.title, start_date: row.start_date, end_date: row.end_date }, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create trip failed') }
  }
}

/** Attach an event/todo to a trip (or detach with null). Children inherit the
 *  trip's audience automatically: the unified RLS surfaces an event whose
 *  group_id points to a container shared with the viewer, so no per-child
 *  share rows are written ("share once → children follow"). */
export async function assignToContainer(
  eventId: string,
  containerId: string | null,
  _opts?: { skipInherit?: boolean },
): Promise<{ error: Error | null }> {
  try {
    await dbClient.events.update(eventId, { group_id: containerId } as Partial<Event>)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Assign trip failed') }
  }
}

/** No-op retained for call-site compatibility. Sharing a trip is now a single
 *  share on the container; its children follow via RLS, so there is nothing to
 *  cascade. */
export async function syncTripSharing(_containerId: string, _memberIds: string[]): Promise<{ count: number; error: Error | null }> {
  return { count: 0, error: null }
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
