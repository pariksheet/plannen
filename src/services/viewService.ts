import { supabase } from '../lib/supabase'
import { Event, resolveEventStatus } from '../types/event'

export async function getMyFeedEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }

  const { data: createdEvents, error: createdError } = await supabase
    .from('events')
    .select('*')
    .eq('created_by', user.id)
    .order('start_date', { ascending: true })

  if (createdError) return { data: null, error: new Error(createdError.message) }

  const { data: rsvpEvents, error: rsvpError } = await supabase
    .from('event_rsvps')
    .select('status, event:events(*)')
    .eq('user_id', user.id)

  if (rsvpError) return { data: null, error: new Error(rsvpError.message) }

  const created = (createdEvents ?? []) as Event[]
  const rsvpRows = (rsvpEvents ?? []) as { status: 'going' | 'maybe' | 'not_going'; event: Event | Event[] | null }[]
  const rsvpStatusByEventId = new Map<string, 'going' | 'maybe' | 'not_going'>()
  rsvpRows.forEach((row) => {
    const event = Array.isArray(row.event) ? row.event[0] : row.event
    if (event?.id) rsvpStatusByEventId.set(event.id, row.status)
  })
  const fromRsvp = rsvpRows
    .filter((r) => r.status !== 'not_going')
    .map((r) => (Array.isArray(r.event) ? r.event[0] : r.event))
    .filter(Boolean) as Event[]

  const byId = new Map<string, Event>()
  created.forEach((e) => {
    const resolved = resolveEventStatus(e)
    byId.set(e.id, { ...resolved, my_rsvp_status: rsvpStatusByEventId.get(e.id) ?? null })
  })
  fromRsvp.forEach((e) => {
    if (!byId.has(e.id)) {
      const resolved = resolveEventStatus(e)
      byId.set(e.id, { ...resolved, my_rsvp_status: rsvpStatusByEventId.get(e.id) ?? null })
    }
  })
  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  )
  return { data: enrichWithRecurrenceContext(merged), error: null }
}

function enrichWithRecurrenceContext(events: Event[]): Event[] {
  const eventById = new Map(events.map((e) => [e.id, e]))
  const sessionsByParentId = new Map<string, Event[]>()
  for (const e of events) {
    if (e.parent_event_id) {
      if (!sessionsByParentId.has(e.parent_event_id)) sessionsByParentId.set(e.parent_event_id, [])
      sessionsByParentId.get(e.parent_event_id)!.push(e)
    }
  }
  const now = new Date()
  return events.map((e) => {
    if (e.parent_event_id) {
      const parent = eventById.get(e.parent_event_id)
      return { ...e, parent_title: parent?.title ?? null }
    }
    if (e.recurrence_rule) {
      const sessions = (sessionsByParentId.get(e.id) ?? []).sort(
        (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
      )
      const next = sessions.find((s) => new Date(s.start_date) >= now)
      return {
        ...e,
        sessions_summary: {
          total: sessions.length,
          past: sessions.filter((s) => s.event_status === 'past').length,
          missed: sessions.filter((s) => s.event_status === 'missed').length,
          next_date: next?.start_date ?? null,
        },
      }
    }
    return e
  })
}

export async function getFamilyEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: events, error } = await getFamilyEventsBySharing()
  return { data: events, error }
}

export async function getFriendsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: events, error } = await getFriendsEventsBySharing()
  return { data: events, error }
}

async function getFamilyEventsBySharing(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data: rels } = await supabase
    .from('relationships')
    .select('user_id, related_user_id')
    .or(`user_id.eq.${user.id},related_user_id.eq.${user.id}`)
    .eq('status', 'accepted')
    .in('relationship_type', ['family', 'both'])
  const otherIds = new Set<string>([user.id])
  ;(rels ?? []).forEach((r: { user_id: string; related_user_id: string }) => {
    otherIds.add(r.user_id)
    otherIds.add(r.related_user_id)
  })
  otherIds.delete(user.id)

  // Events from family members that they shared with family
  let fromFamily: Event[] = []
  if (otherIds.size > 0) {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .in('created_by', Array.from(otherIds))
      .eq('shared_with_family', true)
      .order('start_date', { ascending: true })
    if (error) return { data: null, error: new Error(error.message) }
    fromFamily = (data ?? []).map((e) => resolveEventStatus(e as Event))
  }

  // Also include events I created that I shared with family (so they appear on My Family too)
  const { data: myShared, error: myError } = await supabase
    .from('events')
    .select('*')
    .eq('created_by', user.id)
    .eq('shared_with_family', true)
    .order('start_date', { ascending: true })
  if (myError) return { data: null, error: new Error(myError.message) }
  const myFamilyShared = (myShared ?? []).map((e) => resolveEventStatus(e as Event))

  const byId = new Map<string, Event>()
  ;[...fromFamily, ...myFamilyShared].forEach((e) => byId.set(e.id, e))
  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  )
  return { data: merged, error: null }
}

async function getFriendsEventsBySharing(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data: rels } = await supabase
    .from('relationships')
    .select('user_id, related_user_id')
    .or(`user_id.eq.${user.id},related_user_id.eq.${user.id}`)
    .eq('status', 'accepted')
    .in('relationship_type', ['friend', 'both'])
  const friendIds = new Set<string>([user.id])
  ;(rels ?? []).forEach((r: { user_id: string; related_user_id: string }) => {
    friendIds.add(r.user_id)
    friendIds.add(r.related_user_id)
  })
  friendIds.delete(user.id)
  const friendIdsArr = Array.from(friendIds)

  let eventsAll: Event[] = []
  if (friendIdsArr.length > 0) {
    const { data, error: errAll } = await supabase
      .from('events')
      .select('*')
      .in('created_by', friendIdsArr)
      .eq('shared_with_friends', 'all')
      .order('start_date', { ascending: true })
    if (errAll) return { data: null, error: new Error(errAll.message) }
    eventsAll = (data ?? []) as Event[]
  }

  const { data: sharedRows } = await supabase
    .from('event_shared_with_users')
    .select('event_id')
    .eq('user_id', user.id)
  const selectedEventIds = new Set((sharedRows ?? []).map((r: { event_id: string }) => r.event_id))

  // Events shared with a group I'm in (creator must be a friend)
  const { data: myGroupMemberships } = await supabase
    .from('friend_group_members')
    .select('group_id')
    .eq('user_id', user.id)
  const myGroupIds = (myGroupMemberships ?? []).map((r: { group_id: string }) => r.group_id)
  let eventsFromGroups: Event[] = []
  if (myGroupIds.length > 0 && friendIdsArr.length > 0) {
    const { data: esgRows } = await supabase
      .from('event_shared_with_groups')
      .select('event_id')
      .in('group_id', myGroupIds)
    const groupEventIds = [...new Set((esgRows ?? []).map((r: { event_id: string }) => r.event_id))]
    if (groupEventIds.length > 0) {
      const { data: ev, error: errEv } = await supabase
        .from('events')
        .select('*')
        .in('id', groupEventIds)
        .in('created_by', friendIdsArr)
        .order('start_date', { ascending: true })
      if (!errEv && ev) eventsFromGroups = ev as Event[]
    }
  }

  let eventsSelected: Event[] = []
  if (selectedEventIds.size > 0 && friendIdsArr.length > 0) {
    const selectedIdsArr = Array.from(selectedEventIds)
    const { data: sel, error: errSel } = await supabase
      .from('events')
      .select('*')
      .in('id', selectedIdsArr)
      .eq('shared_with_friends', 'selected')
      .in('created_by', friendIdsArr)
      .order('start_date', { ascending: true })
    if (!errSel && sel) eventsSelected = sel as Event[]
  }

  let eventsInvited: Event[] = []
  if (selectedEventIds.size > 0) {
    const invitedIdsArr = Array.from(selectedEventIds)
    const { data: inv, error: errInv } = await supabase
      .from('events')
      .select('*')
      .in('id', invitedIdsArr)
      .eq('shared_with_friends', 'selected')
      .order('start_date', { ascending: true })
    if (!errInv && inv) eventsInvited = inv as Event[]
  }

  // Also include events I created that I shared with friends or with groups (so they appear on My Friends too)
  const { data: myShared, error: myErr } = await supabase
    .from('events')
    .select('*')
    .eq('created_by', user.id)
    .in('shared_with_friends', ['all', 'selected'])
    .order('start_date', { ascending: true })
  const myFriendsShared = !myErr && myShared ? (myShared as Event[]).map((e) => resolveEventStatus(e)) : []
  const { data: myGroups } = await supabase
    .from('friend_groups')
    .select('id')
    .eq('created_by', user.id)
  const myGroupIdsForShared = (myGroups ?? []).map((g: { id: string }) => g.id)
  let myGroupSharedEvents: Event[] = []
  if (myGroupIdsForShared.length > 0) {
    const { data: esgRows } = await supabase
      .from('event_shared_with_groups')
      .select('event_id')
      .in('group_id', myGroupIdsForShared)
    const myGroupSharedEventIds = [...new Set((esgRows ?? []).map((r: { event_id: string }) => r.event_id))]
    if (myGroupSharedEventIds.length > 0) {
      const { data: myEv } = await supabase
        .from('events')
        .select('*')
        .eq('created_by', user.id)
        .in('id', myGroupSharedEventIds)
        .order('start_date', { ascending: true })
      myGroupSharedEvents = (myEv ?? []).map((e) => resolveEventStatus(e as Event))
    }
  }

  const byId = new Map<string, Event>()
  eventsAll.forEach((e) => byId.set(e.id, resolveEventStatus(e as Event)))
  eventsFromGroups.forEach((e) => byId.set(e.id, resolveEventStatus(e as Event)))
  eventsSelected.forEach((e) => byId.set(e.id, resolveEventStatus(e as Event)))
  eventsInvited.forEach((e) => {
    if (!byId.has(e.id)) byId.set(e.id, resolveEventStatus(e as Event))
  })
  myFriendsShared.forEach((e) => byId.set(e.id, e))
  myGroupSharedEvents.forEach((e) => byId.set(e.id, e))
  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  )
  return { data: merged, error: null }
}

/** Events visible via groups only: from friends shared with a group I'm in + my events shared with my groups */
export async function getGroupsEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data: rels } = await supabase
    .from('relationships')
    .select('user_id, related_user_id')
    .or(`user_id.eq.${user.id},related_user_id.eq.${user.id}`)
    .eq('status', 'accepted')
    .in('relationship_type', ['friend', 'both'])
  const friendIds = new Set<string>([user.id])
  ;(rels ?? []).forEach((r: { user_id: string; related_user_id: string }) => {
    friendIds.add(r.user_id)
    friendIds.add(r.related_user_id)
  })
  friendIds.delete(user.id)
  const friendIdsArr = Array.from(friendIds)

  const { data: myGroupMemberships } = await supabase
    .from('friend_group_members')
    .select('group_id')
    .eq('user_id', user.id)
  const myGroupIds = (myGroupMemberships ?? []).map((r: { group_id: string }) => r.group_id)

  let eventsFromGroups: Event[] = []
  if (myGroupIds.length > 0 && friendIdsArr.length > 0) {
    const { data: esgRows } = await supabase
      .from('event_shared_with_groups')
      .select('event_id')
      .in('group_id', myGroupIds)
    const groupEventIds = [...new Set((esgRows ?? []).map((r: { event_id: string }) => r.event_id))]
    if (groupEventIds.length > 0) {
      const { data: ev, error: errEv } = await supabase
        .from('events')
        .select('*')
        .in('id', groupEventIds)
        .in('created_by', friendIdsArr)
        .order('start_date', { ascending: true })
      if (!errEv && ev) eventsFromGroups = (ev as Event[]).map((e) => resolveEventStatus(e))
    }
  }

  const { data: myGroups } = await supabase
    .from('friend_groups')
    .select('id')
    .eq('created_by', user.id)
  const myGroupIdsForShared = (myGroups ?? []).map((g: { id: string }) => g.id)
  let myGroupSharedEvents: Event[] = []
  if (myGroupIdsForShared.length > 0) {
    const { data: esgRows } = await supabase
      .from('event_shared_with_groups')
      .select('event_id')
      .in('group_id', myGroupIdsForShared)
    const myGroupSharedEventIds = [...new Set((esgRows ?? []).map((r: { event_id: string }) => r.event_id))]
    if (myGroupSharedEventIds.length > 0) {
      const { data: myEv } = await supabase
        .from('events')
        .select('*')
        .eq('created_by', user.id)
        .in('id', myGroupSharedEventIds)
        .order('start_date', { ascending: true })
      myGroupSharedEvents = (myEv ?? []).map((e) => resolveEventStatus(e as Event))
    }
  }

  const byId = new Map<string, Event>()
  eventsFromGroups.forEach((e) => byId.set(e.id, e))
  myGroupSharedEvents.forEach((e) => byId.set(e.id, e))
  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  )
  return { data: merged, error: null }
}
