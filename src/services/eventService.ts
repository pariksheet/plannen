import { dbClient } from '../lib/dbClient'
import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'
import { Event, EventFormData, EventStatus, resolveEventStatus } from '../types/event'
import { createRecurringTask, createEnrollmentMonitorTask } from './agentTaskService'
import { generateSessionDates, RecurrenceRule } from '../utils/recurrence'
import { extractDomain } from '../utils/eventSource'
import { notifyEventShared } from '../lib/notify'
import { applyDefaultShare, setShares, type ShareTarget } from './shareService'

/** Translate an event form's sharing fields into unified event_shares targets. */
function formShareTargets(data: Partial<EventFormData>): ShareTarget[] {
  const targets: ShareTarget[] = []
  if (data.shared_with_friends === 'all') targets.push({ type: 'all' })
  if (data.shared_with_friends === 'selected') {
    for (const id of data.shared_with_user_ids ?? []) targets.push({ type: 'user', id })
  }
  for (const id of data.shared_with_group_ids ?? []) targets.push({ type: 'group', id })
  return targets
}

async function upsertEventSource(_userId: string, enrollmentUrl: string, _eventId: string): Promise<void> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return
  // Best-effort: create or upsert the source row. The backend's POST /api/sources
  // is upsert-on-conflict. event_source_refs is not surfaced via REST yet, so
  // this is a no-op for that join row in Tier 0 — Tier 1 used to write both;
  // we accept the slight regression for now (matches the spec's "thin services").
  try {
    await dbClient.sources.create({ domain, source_url: enrollmentUrl })
  } catch {
    // ignore — non-fatal
  }
}

async function insertSessions(parent: Event, rule: RecurrenceRule): Promise<void> {
  const dates = generateSessionDates(parent.start_date, rule)
  if (!dates.length) return
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]
    await dbClient.events.create({
      title: `${parent.title} – Session ${i + 1}`,
      description: parent.description,
      start_date: d.start.toISOString(),
      end_date: d.end ? d.end.toISOString() : null,
      location: parent.location,
      event_kind: 'session',
      event_type: parent.event_type,
      event_status: parent.event_status,
      created_by: parent.created_by,
      parent_event_id: parent.id,
      hashtags: parent.hashtags ?? [],
    })
  }
}

export async function createEvent(
  data: EventFormData,
  watchForNextOccurrence?: boolean,
  isMissed?: boolean
): Promise<{ data: Event | null; error: Error | null }> {
  let userId: string
  try {
    const me = await dbClient.me.get()
    userId = me.userId
  } catch {
    return { data: null, error: new Error('Not authenticated') }
  }

  const startDate = new Date(data.start_date)
  const now = new Date()
  let eventStatus = data.event_status
  if (!eventStatus) {
    if (data.event_kind === 'todo') {
      eventStatus = 'going' // completion is tracked via completed_at, not status
    } else if (data.event_kind === 'reminder') {
      eventStatus = startDate < now ? 'past' : 'going'
    } else if (watchForNextOccurrence && !isMissed) {
      eventStatus = 'watching'
    } else if (isMissed) {
      eventStatus = 'missed'
    } else if (startDate < now) {
      eventStatus = 'past'
    } else {
      eventStatus = 'going'
    }
  }

  let event: Event
  try {
    event = await dbClient.events.create({
      title: data.title,
      description: data.description || null,
      start_date: data.start_date,
      end_date: data.end_date || null,
      enrollment_url: data.enrollment_url || null,
      enrollment_deadline: data.enrollment_deadline || null,
      enrollment_start_date: data.enrollment_start_date || null,
      image_url: data.image_url || null,
      location: data.location?.trim() || null,
      hashtags: (data.hashtags ?? []).slice(0, 5),
      event_kind: data.event_kind,
      event_type: data.event_type,
      created_by: userId,
      assigned_to: data.event_kind === 'todo' ? userId : null,
      event_status: eventStatus,
    }) as unknown as Event
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create failed') }
  }

  if (data.recurrence_rule) {
    await insertSessions(event, data.recurrence_rule as unknown as RecurrenceRule)
  }
  if (data.event_kind === 'event' && watchForNextOccurrence && data.enrollment_url) {
    await createRecurringTask(event.id, data.enrollment_url)
  }
  if (data.event_kind === 'event' && data.enrollment_deadline) {
    await createEnrollmentMonitorTask(event.id)
  }
  // Sharing: explicit form selection wins; if the caller specified nothing
  // (shared_with_friends omitted), apply the user's default-share rule.
  const targets = formShareTargets(data)
  if (data.shared_with_friends === undefined && targets.length === 0) {
    await applyDefaultShare(event.id)
  } else if (targets.length > 0) {
    await setShares(event.id, targets)
    notifyEventShared(event.id, {
      group_ids: data.shared_with_group_ids,
      user_ids: data.shared_with_friends === 'selected' ? data.shared_with_user_ids : undefined,
    })
  }
  if (data.enrollment_url) {
    await upsertEventSource(userId, data.enrollment_url, event.id)
  }
  return { data: event, error: null }
}

export async function updateEvent(
  id: string,
  data: Partial<EventFormData>,
  opts?: { newStatus?: EventStatus }
): Promise<{ data: Event | null; error: Error | null }> {
  const payload: Record<string, unknown> = { ...data }
  if (payload.end_date === '') payload.end_date = null
  if (payload.enrollment_deadline === '') payload.enrollment_deadline = null
  if (payload.enrollment_start_date === '') payload.enrollment_start_date = null
  if (payload.image_url === '') payload.image_url = null
  if (payload.description === '') payload.description = null
  if (payload.enrollment_url === '') payload.enrollment_url = null
  if (payload.location === '') payload.location = null
  if (Array.isArray(payload.hashtags)) {
    payload.hashtags = (payload.hashtags as string[]).filter(Boolean).slice(0, 5)
  }
  delete payload.event_status
  const sharedWithGroupIds = payload.shared_with_group_ids as string[] | undefined
  const sharedWithUserIds = payload.shared_with_user_ids as string[] | undefined
  delete payload.shared_with_user_ids
  delete payload.shared_with_group_ids
  // shared_with_friends was retired (migration 20260617180000) in favour of the
  // event_shares junction; it's no longer a column, so keep it out of the DB
  // write. The form value is still read below via data.shared_with_friends to
  // derive the unified share targets.
  delete payload.shared_with_friends

  if (opts?.newStatus) {
    payload.event_status = opts.newStatus
  }

  let event: Event
  try {
    event = await dbClient.events.update(id, payload) as unknown as Event
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Update failed') }
  }

  // Re-derive the awareness share set from the form when any sharing field was
  // part of this update. setShares replaces awareness rows but leaves assigned
  // (todo-assignment) rows intact.
  if (sharedWithGroupIds !== undefined || sharedWithUserIds !== undefined || data.shared_with_friends !== undefined) {
    const targets = formShareTargets({
      shared_with_friends: data.shared_with_friends,
      shared_with_user_ids: sharedWithUserIds,
      shared_with_group_ids: sharedWithGroupIds,
    })
    await setShares(id, targets)
    if (targets.length > 0) {
      notifyEventShared(id, {
        group_ids: sharedWithGroupIds,
        user_ids: data.shared_with_friends === 'selected' ? sharedWithUserIds : undefined,
      })
    }
  }
  if (data.enrollment_url) {
    try {
      const me = await dbClient.me.get()
      await upsertEventSource(me.userId, data.enrollment_url, id)
    } catch {
      // ignore
    }
  }
  return { data: event, error: null }
}

export async function deleteEvent(id: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.events.delete(id)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete failed') }
  }
}

export async function getEvent(id: string): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const data = await dbClient.events.get(id) as unknown as Event
    return { data: data ? resolveEventStatus(data) : null, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get failed') }
  }
}

export async function getEventSharedWithUserIds(eventId: string): Promise<{ data: string[]; error: Error | null }> {
  // Tier 0 is single-user — no direct user-shares to read.
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('event_shares')
      .select('target_id')
      .eq('event_id', eventId)
      .eq('target_type', 'user')
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.target_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getEventSharedWithUserIds failed') }
  }
}

export { getEventSharedWithGroupIds } from './groupService'

/**
 * Return all session/child events for a given parent event. Tier-1 only;
 * Tier 0 does not surface child-session listing yet, so returns [].
 */
export async function getChildSessionIds(parentEventId: string): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  const { data, error } = await supabase.from('events').select('id').eq('parent_event_id', parentEventId)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []).map((r) => r.id as string), error: null }
}

export async function getUserEvents(_userId: string): Promise<{ data: Event[] | null; error: Error | null }> {
  try {
    const data = await dbClient.events.list({ limit: 200 })
    return { data: (data as unknown as Event[]).map((e) => resolveEventStatus(e)), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('List failed') }
  }
}

export async function completeTodo(id: string): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const data = await dbClient.events.update(id, { completed_at: new Date().toISOString() }) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Complete failed') }
  }
}

export async function uncompleteTodo(id: string): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const data = await dbClient.events.update(id, { completed_at: null }) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Uncomplete failed') }
  }
}

export async function convertEventKind(id: string, kind: 'reminder' | 'todo'): Promise<{ data: Event | null; error: Error | null }> {
  const patch: Record<string, unknown> = { event_kind: kind }
  if (kind === 'reminder') patch.completed_at = null
  try {
    const data = await dbClient.events.update(id, patch) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Convert failed') }
  }
}
