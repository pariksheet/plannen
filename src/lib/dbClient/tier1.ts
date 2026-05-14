// Tier 1 (Supabase) dbClient implementation. Faithful 1:1 wrappers over
// the existing supabase-js calls used by src/services/*.ts. Each method
// returns plain data and throws on error so the legacy { data, error }
// envelopes can be reconstructed in service passthroughs when needed.

import { supabase } from '../supabase'
import type {
  AgentTaskRow,
  DbClient,
  EventRow,
  FactRow,
  FamilyMemberRow,
  GroupRow,
  InviteRow,
  LocationRow,
  MemoryRow,
  ProfileRow,
  RelationshipRow,
  RsvpRow,
  SettingsRow,
  SourceRow,
  StoryRow,
  WatchTaskRow,
} from './types'

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  if (res.data == null) throw new Error('No data')
  return res.data
}

function unwrapOrNull<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new Error('Not authenticated')
  return data.user.id
}

export const tier1: DbClient = {
  me: {
    async get() {
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) throw new Error('Not authenticated')
      return { userId: data.user.id, email: data.user.email ?? '' }
    },
  },

  // ── events ────────────────────────────────────────────────────────────────
  events: {
    list: async (p) => {
      const uid = await currentUserId()
      let q = supabase
        .from('events')
        .select('*')
        .eq('created_by', uid)
        .order('start_date', { ascending: true })
      if (p?.from_date) q = q.gte('start_date', p.from_date)
      if (p?.to_date) q = q.lte('start_date', p.to_date)
      if (p?.limit) q = q.limit(p.limit)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as EventRow[]
    },
    get: async (id) => unwrap(await supabase.from('events').select('*').eq('id', id).single()) as EventRow,
    create: async (i) => unwrap(await supabase.from('events').insert(i).select().single()) as EventRow,
    update: async (id, p) => unwrap(await supabase.from('events').update(p).eq('id', id).select().single()) as EventRow,
    delete: async (id) => {
      const { error } = await supabase.from('events').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  // ── stories ───────────────────────────────────────────────────────────────
  stories: {
    list: async () => {
      const { data, error } = await supabase
        .from('stories')
        .select('*, story_events(events:event_id(id, title, start_date))')
        .order('generated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as StoryRow[]
    },
    get: async (id) => {
      const { data, error } = await supabase
        .from('stories')
        .select('*, story_events(events:event_id(id, title, start_date))')
        .eq('id', id)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as StoryRow | null
    },
    create: async (i) => unwrap(await supabase.from('stories').insert(i).select().single()) as StoryRow,
    update: async (id, p) => unwrap(await supabase.from('stories').update(p).eq('id', id).select().single()) as StoryRow,
    delete: async (id) => {
      const { error } = await supabase.from('stories').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  // ── memories ──────────────────────────────────────────────────────────────
  memories: {
    list: async (p) => {
      let q = supabase
        .from('event_memories')
        .select('id, event_id, user_id, media_url, media_type, caption, created_at, taken_at, source, external_id, transcript, transcript_lang, transcribed_at, user:users(full_name, email)')
        .order('taken_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
      if (p?.event_id) q = q.eq('event_id', p.event_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as MemoryRow[]
    },
    create: async (i) => unwrap(await supabase.from('event_memories').insert(i).select().single()) as MemoryRow,
    update: async (id, p) => unwrap(await supabase.from('event_memories').update(p).eq('id', id).select().single()) as MemoryRow,
    delete: async (id) => {
      const { error } = await supabase.from('event_memories').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
    uploadFile: async ({ userId, filename, blob, contentType }) => {
      const path = `${userId}/${filename}`
      const { error } = await supabase.storage.from('event-photos').upload(path, blob, { contentType, upsert: false })
      if (error) throw new Error(error.message)
      const { data } = supabase.storage.from('event-photos').getPublicUrl(path)
      return { key: `event-photos/${path}`, publicUrl: data.publicUrl }
    },
  },

  // ── profile ───────────────────────────────────────────────────────────────
  profile: {
    get: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as ProfileRow | null
    },
    update: async (patch) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('user_profiles')
        .upsert({ user_id: uid, ...patch }, { onConflict: 'user_id' })
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as ProfileRow | null
    },
    listFacts: async (params) => {
      const uid = await currentUserId()
      let q = supabase
        .from('profile_facts')
        .select('*')
        .eq('user_id', uid)
        .order('last_seen_at', { ascending: false })
      if (params?.subject) q = q.eq('subject', params.subject)
      if (params?.limit) q = q.limit(params.limit)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as FactRow[]
    },
    upsertFact: async (fact) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('profile_facts')
        .insert({ user_id: uid, ...fact })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as FactRow
    },
    deleteFact: async (id) => {
      const { error } = await supabase.from('profile_facts').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  // ── relationships ─────────────────────────────────────────────────────────
  relationships: {
    listFamilyMembers: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('family_members')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as FamilyMemberRow[]
    },
    createFamilyMember: async (input) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('family_members')
        .insert({ user_id: uid, goals: [], interests: [], ...input })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as FamilyMemberRow
    },
    updateFamilyMember: async (id, patch) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('family_members')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', uid)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as FamilyMemberRow
    },
    deleteFamilyMember: async (id) => {
      const uid = await currentUserId()
      const { error } = await supabase
        .from('family_members')
        .delete()
        .eq('id', id)
        .eq('user_id', uid)
      if (error) throw new Error(error.message)
    },
    listRelationships: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('relationships')
        .select('*')
        .or(`user_id.eq.${uid},related_user_id.eq.${uid}`)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as RelationshipRow[]
    },
  },

  // ── locations ─────────────────────────────────────────────────────────────
  locations: {
    list: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('user_locations')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as LocationRow[]
    },
    create: async (input) => {
      const uid = await currentUserId()
      if (input.is_default) {
        const { error: clearErr } = await supabase
          .from('user_locations')
          .update({ is_default: false })
          .eq('user_id', uid)
        if (clearErr) throw new Error(clearErr.message)
      }
      const { data, error } = await supabase
        .from('user_locations')
        .insert({ user_id: uid, ...input })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as LocationRow
    },
    update: async (id, patch) => {
      const uid = await currentUserId()
      if (patch.is_default) {
        const { error: clearErr } = await supabase
          .from('user_locations')
          .update({ is_default: false })
          .eq('user_id', uid)
          .neq('id', id)
        if (clearErr) throw new Error(clearErr.message)
      }
      const { data, error } = await supabase
        .from('user_locations')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', uid)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as LocationRow
    },
    delete: async (id) => {
      const uid = await currentUserId()
      const { error } = await supabase
        .from('user_locations')
        .delete()
        .eq('id', id)
        .eq('user_id', uid)
      if (error) throw new Error(error.message)
    },
  },

  // ── sources ───────────────────────────────────────────────────────────────
  sources: {
    list: async (params) => {
      const uid = await currentUserId()
      let q = supabase
        .from('event_sources')
        .select('*')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false, nullsFirst: false })
      if (params?.limit) q = q.limit(params.limit)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as SourceRow[]
    },
    create: async (input) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('event_sources')
        .upsert({ user_id: uid, ...input }, { onConflict: 'user_id,domain' })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as SourceRow
    },
    update: async (id, patch) => {
      const { data, error } = await supabase
        .from('event_sources')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as SourceRow
    },
  },

  // ── watch ─────────────────────────────────────────────────────────────────
  watch: {
    list: async (params) => {
      let q = supabase
        .from('agent_tasks')
        .select('*')
        .in('task_type', ['recurring_check', 'enrollment_monitor'])
        .order('next_check', { ascending: true, nullsFirst: false })
      if (params?.event_id) q = q.eq('event_id', params.event_id)
      if (params?.status) q = q.eq('status', params.status)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as WatchTaskRow[]
    },
    create: async (input) => {
      const taskType = (input.task_type as string | undefined) ?? 'recurring_check'
      const { data, error } = await supabase
        .from('agent_tasks')
        .upsert(
          {
            task_type: taskType,
            status: 'active',
            next_check: new Date().toISOString(),
            ...input,
          },
          { onConflict: 'event_id,task_type' },
        )
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as WatchTaskRow
    },
    update: async (id, patch) => {
      const { data, error } = await supabase
        .from('agent_tasks')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as WatchTaskRow
    },
    delete: async (id) => {
      const { error } = await supabase.from('agent_tasks').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  // ── rsvp ──────────────────────────────────────────────────────────────────
  rsvp: {
    upsert: async (input) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('event_rsvps')
        .upsert({ user_id: uid, ...input }, { onConflict: 'event_id,user_id' })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as RsvpRow
    },
  },

  // ── groups ────────────────────────────────────────────────────────────────
  groups: {
    list: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('friend_groups')
        .select('*')
        .eq('created_by', uid)
        .order('name')
      if (error) throw new Error(error.message)
      return (data ?? []) as GroupRow[]
    },
    create: async (input) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('friend_groups')
        .insert({ name: input.name.trim(), created_by: uid })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as GroupRow
    },
    listInvites: async (params) => {
      const uid = await currentUserId()
      let q = supabase
        .from('event_invites')
        .select('*')
        .eq('created_by', uid)
        .order('created_at', { ascending: false })
      if (params?.event_id) q = q.eq('event_id', params.event_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as InviteRow[]
    },
    createInvite: async (input) => {
      const uid = await currentUserId()
      const token = Array.from(crypto.getRandomValues(new Uint8Array(24)),
        (b) => b.toString(16).padStart(2, '0')).join('')
      const days = input.expires_in_days ?? 7
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await supabase
        .from('event_invites')
        .insert({ event_id: input.event_id, token, created_by: uid, expires_at: expiresAt })
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as InviteRow
    },
  },

  // ── wishlist ──────────────────────────────────────────────────────────────
  wishlist: {
    list: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('created_by', uid)
        .in('event_status', ['watching', 'missed'])
        .order('start_date', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as EventRow[]
    },
    create: async (input) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('events')
        .update({ event_status: 'watching' })
        .eq('id', input.event_id)
        .eq('created_by', uid)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as EventRow
    },
    delete: async (id) => {
      const uid = await currentUserId()
      const { error } = await supabase
        .from('events')
        .update({ event_status: 'going' })
        .eq('id', id)
        .eq('created_by', uid)
      if (error) throw new Error(error.message)
    },
  },

  // ── settings ──────────────────────────────────────────────────────────────
  settings: {
    get: async () => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .eq('user_id', uid)
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as SettingsRow | null
    },
    update: async (patch) => {
      const uid = await currentUserId()
      const { data, error } = await supabase
        .from('user_settings')
        .upsert({ user_id: uid, ...patch }, { onConflict: 'user_id,provider' })
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as SettingsRow | null
    },
  },

  // ── agentTasks ────────────────────────────────────────────────────────────
  agentTasks: {
    list: async (params) => {
      let q = supabase
        .from('agent_tasks')
        .select('*')
        .order('created_at', { ascending: false })
      if (params?.event_id) q = q.eq('event_id', params.event_id)
      if (params?.task_type) q = q.eq('task_type', params.task_type)
      if (params?.limit) q = q.limit(params.limit)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as AgentTaskRow[]
    },
    create: async (input) => {
      const { data, error } = await supabase
        .from('agent_tasks')
        .upsert(
          {
            status: 'active',
            next_check: new Date().toISOString(),
            ...input,
          },
          { onConflict: 'event_id,task_type' },
        )
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as AgentTaskRow
    },
  },

  // ── functions ─────────────────────────────────────────────────────────────
  functions: {
    invoke: async <T>(name: string, body?: unknown) => {
      const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> | undefined })
      if (error) throw new Error(error.message)
      return data as T
    },
  },

  // ── realtime ──────────────────────────────────────────────────────────────
  realtime: {
    subscribeToStories: (cb) => {
      const ch = supabase
        .channel('stories-changes')
        .on(
          'postgres_changes' as never,
          { event: '*', schema: 'plannen', table: 'stories' } as never,
          () => cb(),
        )
        .subscribe()
      return () => {
        supabase.removeChannel(ch)
      }
    },
  },

  // ─ ─ unwrapOrNull used internally; suppress unused warning ─ ─
  // (kept for completeness — see profile/settings .get which return null)
}

// Ensure unwrapOrNull is referenced so TS does not flag noUnusedLocals.
void unwrapOrNull
