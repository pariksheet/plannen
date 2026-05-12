import { supabase } from '../lib/supabase'
import { Event, EventFormData, EventStatus, resolveEventStatus } from '../types/event'
import { createRecurringTask, createEnrollmentMonitorTask } from './agentTaskService'
import { setEventSharedWithGroups } from './groupService'
import { generateSessionDates, RecurrenceRule } from '../utils/recurrence'
import { extractDomain } from '../utils/eventSource'

async function upsertEventSource(userId: string, enrollmentUrl: string, eventId: string): Promise<void> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return
  const { data: source, error } = await supabase
    .from('event_sources')
    .upsert(
      { user_id: userId, domain, source_url: enrollmentUrl },
      { onConflict: 'user_id,domain' }
    )
    .select('id')
    .single()
  if (error || !source) return
  await supabase.from('event_source_refs').upsert(
    { event_id: eventId, source_id: source.id, user_id: userId, ref_type: 'enrollment_url' },
    { onConflict: 'event_id,source_id' }
  )
}

async function insertSessions(parent: Event, rule: RecurrenceRule): Promise<void> {
  const dates = generateSessionDates(parent.start_date, rule)
  if (!dates.length) return
  const sessions = dates.map((d, i) => ({
    title: `${parent.title} – Session ${i + 1}`,
    description: parent.description,
    start_date: d.start.toISOString(),
    end_date: d.end ? d.end.toISOString() : null,
    location: parent.location,
    event_kind: 'session' as const,
    event_type: parent.event_type,
    event_status: parent.event_status,
    created_by: parent.created_by,
    parent_event_id: parent.id,
    shared_with_family: parent.shared_with_family,
    shared_with_friends: parent.shared_with_friends,
    hashtags: parent.hashtags ?? [],
  }))
  await supabase.from('events').insert(sessions)
}

export async function createEvent(
  data: EventFormData,
  watchForNextOccurrence?: boolean,
  isMissed?: boolean
): Promise<{ data: Event | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }

  const startDate = new Date(data.start_date)
  const now = new Date()
  let eventStatus = data.event_status
  if (!eventStatus) {
    if (data.event_kind === 'reminder') {
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

  const { data: event, error } = await supabase
    .from('events')
    .insert({
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
      created_by: user.id,
      event_status: eventStatus,
      shared_with_family: data.shared_with_family ?? false,
      shared_with_friends: data.shared_with_friends ?? 'none',
    })
    .select()
    .single()

  if (error) return { data: null, error: new Error(error.message) }
  if (event && data.recurrence_rule) {
    await insertSessions(event as Event, data.recurrence_rule as unknown as RecurrenceRule)
  }
  if (event && data.event_kind === 'event' && watchForNextOccurrence && data.enrollment_url) {
    await createRecurringTask(event.id, data.enrollment_url)
  }
  if (event && data.event_kind === 'event' && data.enrollment_deadline) {
    await createEnrollmentMonitorTask(event.id)
  }
  if (event && data.shared_with_friends === 'selected' && data.shared_with_user_ids?.length) {
    await supabase.from('event_shared_with_users').insert(
      data.shared_with_user_ids.map((user_id) => ({ event_id: event.id, user_id }))
    )
  }
  if (event && data.shared_with_group_ids?.length) {
    await setEventSharedWithGroups(event.id, data.shared_with_group_ids)
  }
  if (event && data.enrollment_url) {
    await upsertEventSource(user.id, data.enrollment_url, event.id)
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
  const sharedWithUserIds = payload.shared_with_user_ids as string[] | undefined
  const sharedWithGroupIds = payload.shared_with_group_ids as string[] | undefined
  delete payload.shared_with_user_ids
  delete payload.shared_with_group_ids

  if (opts?.newStatus) {
    payload.event_status = opts.newStatus
  }

  const { data: event, error } = await supabase
    .from('events')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  if (event && (payload.shared_with_friends !== undefined || sharedWithUserIds !== undefined)) {
    await supabase.from('event_shared_with_users').delete().eq('event_id', id)
    if (payload.shared_with_friends === 'selected' && sharedWithUserIds?.length) {
      await supabase.from('event_shared_with_users').insert(
        sharedWithUserIds.map((user_id: string) => ({ event_id: id, user_id }))
      )
    }
  }
  if (event && sharedWithGroupIds !== undefined) {
    await setEventSharedWithGroups(id, sharedWithGroupIds)
  }
  if (event && data.enrollment_url) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await upsertEventSource(user.id, data.enrollment_url, id)
  }
  return { data: event, error: null }
}

export async function deleteEvent(id: string): Promise<{ error: Error | null }> {
  const { error } = await supabase.from('events').delete().eq('id', id)
  return { error: error ? new Error(error.message) : null }
}

export async function getEvent(id: string): Promise<{ data: Event | null; error: Error | null }> {
  const { data, error } = await supabase.from('events').select('*').eq('id', id).single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data ? resolveEventStatus(data as Event) : null, error: null }
}

export async function getEventSharedWithUserIds(eventId: string): Promise<{ data: string[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('event_shared_with_users')
    .select('user_id')
    .eq('event_id', eventId)
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []).map((r: { user_id: string }) => r.user_id), error: null }
}

export { getEventSharedWithGroupIds } from './groupService'

export async function getUserEvents(userId: string): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('created_by', userId)
    .order('start_date', { ascending: true })
  if (error) return { data: null, error: new Error(error.message) }
  return { data: (data ?? []).map((e) => resolveEventStatus(e as Event)), error: null }
}
