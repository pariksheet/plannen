// Tier 1 (Supabase) dbClient implementation. Faithful 1:1 wrappers over
// the existing supabase-js calls used by src/services/*.ts. Each method
// returns plain data and throws on error so the legacy { data, error }
// envelopes can be reconstructed in service passthroughs when needed.

import { supabase } from '../supabase'
import type {
  AgentTaskRow,
  AttendanceBlackoutWindowRow,
  AttendanceRow,
  ChecklistItemRow,
  ChecklistRow,
  DailyBriefingRow,
  DbClient,
  ObligationRow,
  EventProvenanceRow,
  EventRow,
  FactRow,
  FamilyMemberRow,
  GroupRow,
  IgnoreRuleInput,
  IgnoreRuleRow,
  IgnoreRuleSpec,
  InviteRow,
  LocationRow,
  MemoryRow,
  NoteRow,
  PracticeCompletionRow,
  PracticeRow,
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
    async signup() {
      throw new Error('signup is tier-0 only; tier 1 uses magic-link auth via supabase.auth.signInWithOtp')
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
    getProvenance: async (eventId) => {
      const { data, error } = await supabase
        .from('event_provenance')
        .select('*')
        .eq('event_id', eventId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as EventProvenanceRow | null
    },
  },

  // ── stories ───────────────────────────────────────────────────────────────
  stories: {
    list: async (params) => {
      let q = supabase
        .from('stories')
        .select('*, story_events(events:event_id(id, title, start_date))')
        .order('generated_at', { ascending: false })
      if (params?.story_group_id) q = q.eq('story_group_id', params.story_group_id)
      const { data, error } = await q
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
      if (p?.event_ids && p.event_ids.length > 0) q = q.in('event_id', p.event_ids)
      else if (p?.event_id) q = q.eq('event_id', p.event_id)
      if (p?.limit) q = q.limit(p.limit)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as MemoryRow[]
    },
    create: async (i) => {
      const uid = await currentUserId()
      return unwrap(
        await supabase.from('event_memories').insert({ ...i, user_id: uid }).select().single(),
      ) as MemoryRow
    },
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

  // ── notes ─────────────────────────────────────────────────────────────────
  notes: {
    list: async ({ event_id }) => {
      const { data, error } = await supabase
        .from('event_notes')
        .select('id, event_id, user_id, body, created_at, updated_at, author:users(full_name, email)')
        .eq('event_id', event_id)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as NoteRow[]
    },
    create: async (i) => {
      const uid = await currentUserId()
      return unwrap(
        await supabase
          .from('event_notes')
          .insert({ event_id: i.event_id, body: i.body.trim(), user_id: uid })
          .select('id, event_id, user_id, body, created_at, updated_at, author:users(full_name, email)')
          .single(),
      ) as unknown as NoteRow
    },
    update: async (id, p) =>
      unwrap(
        await supabase
          .from('event_notes')
          .update({ body: p.body.trim() })
          .eq('id', id)
          .select('id, event_id, user_id, body, created_at, updated_at, author:users(full_name, email)')
          .single(),
      ) as unknown as NoteRow,
    delete: async (id) => {
      const { error } = await supabase.from('event_notes').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  // ── ignoreRules ───────────────────────────────────────────────────────────
  ignoreRules: {
    list: async (params?: { adapter_id?: string }) => {
      const uid = await currentUserId()
      let q = supabase
        .from('mailbox_ignore_rules')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
      if (params?.adapter_id) q = q.eq('adapter_id', params.adapter_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as IgnoreRuleRow[]
    },
    add: async (input: IgnoreRuleInput) => {
      const uid = await currentUserId()
      if (input.kind === 'domain_subject' && !input.subject_keyword) {
        throw new Error('subject_keyword is required when kind=domain_subject')
      }
      if (input.kind !== 'domain_subject' && input.subject_keyword) {
        throw new Error('subject_keyword is only allowed when kind=domain_subject')
      }
      const pattern = input.pattern.trim().toLowerCase()
      const subjectKeyword = input.subject_keyword ? input.subject_keyword.trim() : null
      return unwrap(
        await supabase
          .from('mailbox_ignore_rules')
          .upsert({
            user_id: uid,
            adapter_id: input.adapter_id,
            kind: input.kind,
            pattern,
            subject_keyword: subjectKeyword,
            source_event_id: input.source_event_id ?? null,
            source_message_id: input.source_message_id ?? null,
            reason: input.reason ?? null,
          }, { onConflict: 'user_id,adapter_id,kind,pattern,subject_keyword' })
          .select()
          .single(),
      ) as IgnoreRuleRow
    },
    delete: async (id) => {
      const { error } = await supabase.from('mailbox_ignore_rules').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
    findMatchingMbsyncEvents: async (spec: IgnoreRuleSpec) => {
      if (spec.kind === 'domain_subject' && !spec.subject_keyword) {
        throw new Error('subject_keyword is required when kind=domain_subject')
      }
      if (spec.kind !== 'domain_subject' && spec.subject_keyword) {
        throw new Error('subject_keyword is only allowed when kind=domain_subject')
      }
      const { data, error } = await supabase.rpc('find_matching_mbsync_events', {
        rule_kind: spec.kind,
        rule_pattern: spec.pattern.trim().toLowerCase(),
        rule_subject: spec.subject_keyword?.trim() ?? null,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as EventRow[]
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
      // full_name + avatar_url live on plannen.users; everything else lives on
      // user_profiles. Split the patch the same way the Tier-0 REST route does.
      const { full_name, avatar_url, ...rest } = patch as Record<string, unknown>
      if (full_name !== undefined || avatar_url !== undefined) {
        const usersPatch: Record<string, unknown> = {}
        if (full_name !== undefined) usersPatch.full_name = full_name
        if (avatar_url !== undefined) usersPatch.avatar_url = avatar_url
        const { error: usersErr } = await supabase.from('users').update(usersPatch).eq('id', uid)
        if (usersErr) throw new Error(usersErr.message)
      }
      if (Object.keys(rest).length === 0) {
        const { data } = await supabase.from('user_profiles').select('*').eq('user_id', uid).maybeSingle()
        return (data ?? null) as ProfileRow | null
      }
      const { data, error } = await supabase
        .from('user_profiles')
        .upsert({ user_id: uid, ...rest }, { onConflict: 'user_id' })
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
      // RLS surfaces both owned groups and groups the user is a member of.
      // Filtering by created_by here would hide member-only groups.
      const { data, error } = await supabase
        .from('friend_groups')
        .select('*')
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
    // Tier 1 has no backend boot probe — the CLI provider is unreachable.
    system: async () => ({ tier: 1, cliAvailable: false, cliVersion: null }),
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

  // ── practices ────────────────────────────────────────────────────────────
  practices: {
    list: async (params) => {
      const userId = await currentUserId()
      let q = supabase.from('practices').select('*').eq('user_id', userId).order('created_at', { ascending: true })
      if (params?.active_only) q = q.eq('active', true)
      return unwrap(await q) as PracticeRow[]
    },
    create: async (input) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('practices').insert({ ...input, user_id: userId }).select().single()) as PracticeRow
    },
    update: async (id, patch) => {
      return unwrap(await supabase.from('practices').update(patch).eq('id', id).select().single()) as PracticeRow
    },
    delete: async (id) => {
      const { error } = await supabase.from('practices').update({ active: false }).eq('id', id)
      if (error) throw new Error(error.message)
    },
    markDone: async (input) => {
      const userId = await currentUserId()
      const date = input.completed_on ?? new Date().toISOString().slice(0, 10)
      const { error } = await supabase.from('practice_completions').insert({
        practice_id: input.practice_id,
        user_id: userId,
        family_member_id: input.family_member_id ?? null,
        completed_on: date,
      })
      // Treat unique-violation as success (idempotent).
      if (error && error.code !== '23505') throw new Error(error.message)
    },
    unmarkDone: async (input) => {
      const userId = await currentUserId()
      let q = supabase.from('practice_completions').delete()
        .eq('practice_id', input.practice_id)
        .eq('user_id', userId)
        .eq('completed_on', input.completed_on)
      if (input.family_member_id == null) q = q.is('family_member_id', null)
      else q = q.eq('family_member_id', input.family_member_id)
      const { error } = await q
      if (error) throw new Error(error.message)
    },
    completionsThisWeek: async (date) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('practice_completions')
        .select('practice_id, completed_on')
        .eq('user_id', userId)
        .gte('completed_on', date)) as PracticeCompletionRow[]
    },
  },

  // ── checklists ────────────────────────────────────────────────────────────
  checklists: {
    list: async (params) => {
      let q = supabase.from('checklists').select('*, items:checklist_items(*)').order('created_at', { ascending: false })
      if (params?.event_id) q = q.eq('event_id', params.event_id)
      const rows = unwrap(await q) as ChecklistRow[]
      return rows.map((r) => ({ ...r, total: r.items?.length ?? 0, done: r.items?.filter((i) => i.checked_at != null).length ?? 0 }))
    },
    get: async (id) => {
      const row = unwrap(await supabase.from('checklists').select('*, items:checklist_items(*)').eq('id', id).single()) as ChecklistRow
      row.items = (row.items ?? []).slice().sort((a, b) => a.position - b.position)
      return row
    },
    create: async (input) => {
      const userId = await currentUserId()
      // Mirror the MCP/backend guard: an attached event must be a container the
      // caller owns. RLS already scopes the row to the user; we additionally
      // require event_kind='container' so a checklist can't attach to a plain event.
      if (input.event_id) {
        const { data: ev } = await supabase.from('events').select('id').eq('id', input.event_id).eq('created_by', userId).eq('event_kind', 'container').maybeSingle()
        if (!ev) throw new Error('event_id must be a container you own')
      }
      const cl = unwrap(await supabase.from('checklists').insert({ title: input.title, event_id: input.event_id ?? null, created_by: userId }).select().single()) as ChecklistRow
      const texts = (input.items ?? []).filter((t) => t.trim().length > 0)
      cl.items = texts.length
        ? unwrap(await supabase.from('checklist_items').insert(texts.map((text, position) => ({ checklist_id: cl.id, text, position }))).select()) as ChecklistItemRow[]
        : []
      return cl
    },
    delete: async (id) => { const { error } = await supabase.from('checklists').delete().eq('id', id); if (error) throw new Error(error.message) },
    addItems: async (id, items) => {
      const { data: existing } = await supabase.from('checklist_items').select('position').eq('checklist_id', id)
      const start = existing && existing.length ? Math.max(...existing.map((r) => r.position as number)) + 1 : 0
      const rows = items.filter((t) => t.trim().length > 0).map((text, i) => ({ checklist_id: id, text, position: start + i }))
      if (!rows.length) return []
      return unwrap(await supabase.from('checklist_items').insert(rows).select()) as ChecklistItemRow[]
    },
    setItemChecked: async (itemId, checked) => {
      const userId = await currentUserId()
      const patch = checked ? { checked_at: new Date().toISOString(), checked_by: userId } : { checked_at: null, checked_by: null }
      return unwrap(await supabase.from('checklist_items').update(patch).eq('id', itemId).select().single()) as ChecklistItemRow
    },
    updateItem: async (itemId, text) => unwrap(await supabase.from('checklist_items').update({ text }).eq('id', itemId).select().single()) as ChecklistItemRow,
    deleteItem: async (itemId) => { const { error } = await supabase.from('checklist_items').delete().eq('id', itemId); if (error) throw new Error(error.message) },
    share: async (id, input) => {
      if (input.user_ids?.length) { const { error } = await supabase.from('checklist_shared_with_users').upsert(input.user_ids.map((user_id) => ({ checklist_id: id, user_id }))); if (error) throw new Error(error.message) }
      if (input.group_ids?.length) { const { error } = await supabase.from('checklist_shared_with_groups').upsert(input.group_ids.map((group_id) => ({ checklist_id: id, group_id }))); if (error) throw new Error(error.message) }
    },
  },

  // ── briefings ─────────────────────────────────────────────────────────────
  briefings: {
    getByDate: async (date) => {
      const userId = await currentUserId()
      const res = await supabase.from('daily_briefings')
        .select('*').eq('user_id', userId).eq('briefing_date', date).maybeSingle()
      return unwrapOrNull(res) as DailyBriefingRow | null
    },
    save: async (input) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('daily_briefings')
        .upsert({ ...input, user_id: userId }, { onConflict: 'user_id,briefing_date' })
        .select().single()) as DailyBriefingRow
    },
  },

  // ── scheduling (raw rows for client-side projection) ──────────────────────
  scheduling: {
    listAttendances: async () => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('attendances')
        .select('id, user_id, family_member_id, name, location_id, recurrence_rule, dtstart, recurrence_until, time_of_day, start_time, end_time, priority, active')
        .eq('user_id', userId)
        .eq('active', true)) as AttendanceRow[]
    },
    listAttendanceBlackoutWindows: async () => {
      const userId = await currentUserId()
      // attendance_blackouts links an attendance to a blackout calendar; the
      // windows live on blackout_windows keyed by the same calendar_id. Fetch
      // both for the user and join client-side (supabase-js can't express a
      // join across a non-FK shared key cleanly).
      const links = unwrap(await supabase.from('attendance_blackouts')
        .select('attendance_id, calendar_id')
        .eq('user_id', userId)) as { attendance_id: string; calendar_id: string }[]
      if (links.length === 0) return []
      const calendarIds = Array.from(new Set(links.map((l) => l.calendar_id)))
      const windows = unwrap(await supabase.from('blackout_windows')
        .select('calendar_id, starts_on, ends_on, label')
        .in('calendar_id', calendarIds)) as {
          calendar_id: string; starts_on: string; ends_on: string; label: string | null
        }[]
      const byCalendar = new Map<string, typeof windows>()
      for (const w of windows) {
        const list = byCalendar.get(w.calendar_id) ?? []
        list.push(w)
        byCalendar.set(w.calendar_id, list)
      }
      return links.flatMap((link) =>
        (byCalendar.get(link.calendar_id) ?? []).map((w) => ({
          attendance_id: link.attendance_id,
          calendar_id: w.calendar_id,
          starts_on: w.starts_on,
          ends_on: w.ends_on,
          label: w.label,
        })),
      ) as AttendanceBlackoutWindowRow[]
    },
    listObligationsWithMember: async () => {
      const userId = await currentUserId()
      // Embed the derived-from attendance to lift its family_member_id.
      const rows = unwrap(await supabase.from('obligations')
        .select('id, user_id, derived_from_attendance_id, role, anchor, offset_minutes, location_id, active, attendances!inner(family_member_id, active)')
        .eq('user_id', userId)
        .eq('active', true)
        .eq('attendances.active', true)) as Array<
          ObligationRow & { attendances: { family_member_id: string } | { family_member_id: string }[] }
        >
      return rows.map((r) => {
        const att = Array.isArray(r.attendances) ? r.attendances[0] : r.attendances
        const { attendances: _omit, ...ob } = r
        return { ...(ob as ObligationRow), member_id: att.family_member_id }
      })
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
