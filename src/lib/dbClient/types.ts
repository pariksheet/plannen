// Shared interface implemented by both tier impls. Domain-keyed methods.
// Method signatures are derived from the corresponding REST endpoints +
// supabase-js equivalents — the contract test asserts shape parity across
// tiers. Row types are intentionally permissive (Record<string, unknown> or
// concrete-ish shapes where the web app already consumes specific fields).

export type ApiEnvelope<T> = { data: T } | { error: { code: string; message: string; hint?: string } }

// ── Domain row shapes ───────────────────────────────────────────────────────
// Mirrors the columns used by `src/services/*` so passthroughs stay typed.

export type EventRow = Record<string, unknown> & {
  id: string
  title: string
  start_date: string
  end_date: string | null
  created_by: string
  location: string | null
  description: string | null
  enrollment_url: string | null
  enrollment_deadline: string | null
  enrollment_start_date: string | null
  image_url: string | null
  event_kind: string | null
  event_type: string | null
  event_status: string | null
  shared_with_friends: string | null
  hashtags: string[] | null
  parent_event_id: string | null
}

export type StoryRow = Record<string, unknown> & {
  id: string
  user_id: string
  title: string
  body: string
  cover_url: string | null
  language: string
  story_group_id: string | null
  generated_at: string | null
  created_at: string
  events?: Array<{ id: string; title: string; start_date: string }>
}

export type MemoryRow = Record<string, unknown> & {
  id: string
  event_id: string
  user_id: string
  media_url: string | null
  media_type: string
  caption: string | null
  taken_at: string | null
  created_at: string
  source: string | null
  external_id: string | null
  transcript: string | null
  transcript_lang: string | null
  transcribed_at: string | null
}

export type NoteRow = Record<string, unknown> & {
  id: string
  event_id: string
  user_id: string
  body: string
  created_at: string
  updated_at: string
  author?: { full_name?: string | null; email?: string | null } | null
}

export type ProfileRow = Record<string, unknown> & {
  user_id: string
  dob: string | null
  goals: string[]
  interests: string[]
  timezone: string
  story_languages: string[] | null
}

export type FactRow = Record<string, unknown> & {
  id: string
  user_id: string
  subject: string
  predicate: string
  value: string
  confidence: number
  source: string
  is_historical: boolean
  last_seen_at: string
}

export type PracticeRecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[] // MO,TU,WE,TH,FR,SA,SU
}

export type PracticeRow = Record<string, unknown> & {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule: PracticeRecurrenceRule | null
  dtstart: string
  recurrence_until: string | null
  flex_period: 'week' | 'month' | null
  flex_target: number | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
  created_at: string
  updated_at: string
}

export type PracticeCompletionRow = {
  practice_id: string
  completed_on: string
}

// ── attendances + derived obligations (unified scheduling, Phase 2/3) ────────
// Persisted rows. Mirrors plannen.attendances / plannen.obligations.
export type AttendanceRow = Record<string, unknown> & {
  id: string
  user_id: string
  family_member_id: string
  name: string
  location_id: string | null
  recurrence_rule: PracticeRecurrenceRule
  dtstart: string // YYYY-MM-DD
  recurrence_until: string | null // YYYY-MM-DD; NULL = open-ended
  time_of_day: string | null
  start_time: string | null // HH:MM
  end_time: string | null // HH:MM
  priority: number
  active: boolean
}

export type ObligationRow = Record<string, unknown> & {
  id: string
  user_id: string
  derived_from_attendance_id: string
  role: 'drop' | 'pick'
  anchor: 'start' | 'end'
  offset_minutes: number
  location_id: string | null
  active: boolean
}

// Read-time projections returned by get_briefing_context (attendances_today /
// obligations_today). These mirror the shapes computed server-side in
// supabase/functions/_shared/scheduling.ts — keep in sync if those drift.
//
// An AttendanceInstance is INDICATIVE context (a member is somewhere on a
// schedule). It must NOT be fed to the conflict/overlap checker — render muted.
export type AttendanceInstanceRow = {
  attendance_id: string
  family_member_id: string
  date: string // YYYY-MM-DD
  name: string
  location_id: string | null
  start_time: string | null // HH:MM
  end_time: string | null // HH:MM
  priority: number
  dtstart: string // YYYY-MM-DD
  recurrence_until: string | null // YYYY-MM-DD
}

// A ResolvedObligation is an ACTIONABLE timed drop/pick task projected onto its
// member's winning attendance instance for the day. Render like a timed item.
export type ResolvedObligationRow = {
  obligation_id: string
  role: 'drop' | 'pick'
  date: string // YYYY-MM-DD
  time: string // HH:MM after anchor + offset
  location_id: string | null // own, else inherited from the winning instance
  source_attendance_id: string
  source_name: string
}

export type DailyBriefingRow = {
  id: string
  briefing_date: string
  content_md: string
  summary: string | null
  source: 'claude_code' | 'claude_desktop' | 'web' | 'cron'
  generated_at: string
}

export type FamilyMemberRow = Record<string, unknown> & {
  id: string
  user_id: string
  name: string
  relation: string
  dob: string | null
  gender: string | null
  goals: string[]
  interests: string[]
}

export type RelationshipRow = Record<string, unknown> & {
  id: string
  user_id: string
  related_user_id: string
  status: string
  created_at: string
}

export type LocationRow = Record<string, unknown> & {
  id: string
  user_id: string
  label: string
  address: string
  city: string
  country: string
  is_default: boolean
}

export type SourceRow = Record<string, unknown> & {
  id: string
  user_id: string
  domain: string
  source_url: string
  name: string | null
  tags: string[] | null
  source_type: string | null
}

export type WatchTaskRow = Record<string, unknown> & {
  id: string
  event_id: string
  task_type: string
  status: string
  next_check: string | null
  last_checked_at: string | null
  last_result: Record<string, unknown> | null
  fail_count: number
  has_unread_update: boolean
  update_summary: string | null
  recurrence_months: number | null
  last_occurrence_date: string | null
}

export type RsvpRow = Record<string, unknown> & {
  event_id: string
  user_id: string
  status: string
  preferred_visit_date: string | null
}

export type GroupRow = Record<string, unknown> & {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type InviteRow = Record<string, unknown> & {
  id: string
  event_id: string
  token: string
  created_by: string
  expires_at: string | null
}

export type SettingsRow = Record<string, unknown> & {
  user_id: string
  provider: string
  has_api_key?: boolean
  base_url: string | null
  default_model: string | null
  is_default: boolean
}

export type AgentTaskRow = Record<string, unknown> & {
  id: string
  event_id: string
  task_type: string
  status: string
  next_check: string | null
}

// ── mailbox ignore rules ────────────────────────────────────────────────────

export type IgnoreRuleKind = 'sender' | 'domain' | 'domain_subject'

export type IgnoreRuleRow = {
  id: string
  user_id: string
  adapter_id: string
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword: string | null
  source_event_id: string | null
  source_message_id: string | null
  reason: string | null
  hit_count: number
  last_hit_at: string | null
  created_at: string
}

export type IgnoreRuleSpec = {
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword?: string | null
}

export type IgnoreRuleInput = IgnoreRuleSpec & {
  adapter_id: string
  source_event_id?: string | null
  source_message_id?: string | null
  reason?: string | null
}

// ── event provenance ────────────────────────────────────────────────────────

export type EventProvenanceRow = {
  event_id: string
  source: string
  adapter_id: string | null
  source_message_id: string | null
  sender_display: string | null
  sender_email: string | null
  sender_domain: string | null
  subject: string | null
  created_at: string
}

// ── DbClient interface ──────────────────────────────────────────────────────

export type DbClient = {
  events: {
    list: (params?: { limit?: number; from_date?: string; to_date?: string }) => Promise<EventRow[]>
    get: (id: string) => Promise<EventRow>
    create: (input: Partial<EventRow> & { title: string; start_date: string }) => Promise<EventRow>
    update: (id: string, patch: Partial<EventRow>) => Promise<EventRow>
    delete: (id: string) => Promise<void>
    getProvenance: (eventId: string) => Promise<EventProvenanceRow | null>
  }
  stories: {
    list: (params?: { story_group_id?: string }) => Promise<StoryRow[]>
    get: (id: string) => Promise<StoryRow | null>
    create: (input: Partial<StoryRow> & { title: string; body: string }) => Promise<StoryRow>
    update: (id: string, patch: Partial<StoryRow>) => Promise<StoryRow>
    delete: (id: string) => Promise<void>
  }
  memories: {
    list: (params?: { event_id?: string; event_ids?: string[]; limit?: number }) => Promise<MemoryRow[]>
    create: (input: Partial<MemoryRow> & { event_id: string }) => Promise<MemoryRow>
    update: (id: string, patch: Partial<MemoryRow>) => Promise<MemoryRow>
    delete: (id: string) => Promise<void>
    uploadFile: (params: { userId: string; filename: string; blob: Blob; contentType: string }) => Promise<{ key: string; publicUrl: string }>
  }
  notes: {
    list: (params: { event_id: string }) => Promise<NoteRow[]>
    create: (input: { event_id: string; body: string }) => Promise<NoteRow>
    update: (id: string, patch: { body: string }) => Promise<NoteRow>
    delete: (id: string) => Promise<void>
  }
  ignoreRules: {
    list: (params?: { adapter_id?: string }) => Promise<IgnoreRuleRow[]>
    add: (input: IgnoreRuleInput) => Promise<IgnoreRuleRow>
    delete: (id: string) => Promise<void>
    findMatchingMbsyncEvents: (spec: IgnoreRuleSpec) => Promise<EventRow[]>
  }
  profile: {
    get: () => Promise<ProfileRow | null>
    update: (patch: Partial<ProfileRow>) => Promise<ProfileRow | null>
    listFacts: (params?: { subject?: string; limit?: number }) => Promise<FactRow[]>
    upsertFact: (fact: Partial<FactRow> & { subject: string; predicate: string; value: string }) => Promise<FactRow>
    deleteFact: (id: string) => Promise<void>
  }
  relationships: {
    listFamilyMembers: () => Promise<FamilyMemberRow[]>
    createFamilyMember: (input: Partial<FamilyMemberRow> & { name: string; relation: string }) => Promise<FamilyMemberRow>
    updateFamilyMember: (id: string, patch: Partial<FamilyMemberRow>) => Promise<FamilyMemberRow>
    deleteFamilyMember: (id: string) => Promise<void>
    listRelationships: () => Promise<RelationshipRow[]>
  }
  locations: {
    list: () => Promise<LocationRow[]>
    create: (input: Partial<LocationRow> & { label: string }) => Promise<LocationRow>
    update: (id: string, patch: Partial<LocationRow>) => Promise<LocationRow>
    delete: (id: string) => Promise<void>
  }
  sources: {
    list: (params?: { limit?: number }) => Promise<SourceRow[]>
    create: (input: Partial<SourceRow> & { domain: string; source_url: string }) => Promise<SourceRow>
    update: (id: string, patch: Partial<SourceRow>) => Promise<SourceRow>
  }
  watch: {
    list: (params?: { event_id?: string; status?: string }) => Promise<WatchTaskRow[]>
    create: (input: Partial<WatchTaskRow> & { event_id: string }) => Promise<WatchTaskRow>
    update: (id: string, patch: Partial<WatchTaskRow>) => Promise<WatchTaskRow>
    delete: (id: string) => Promise<void>
  }
  rsvp: {
    upsert: (input: { event_id: string; status: string; preferred_visit_date?: string | null }) => Promise<RsvpRow>
  }
  groups: {
    list: () => Promise<GroupRow[]>
    create: (input: { name: string }) => Promise<GroupRow>
    listInvites: (params?: { event_id?: string }) => Promise<InviteRow[]>
    createInvite: (input: { event_id: string; expires_in_days?: number }) => Promise<InviteRow>
  }
  wishlist: {
    list: () => Promise<EventRow[]>
    create: (input: { event_id: string }) => Promise<EventRow>
    delete: (id: string) => Promise<void>
  }
  settings: {
    get: () => Promise<SettingsRow | null>
    update: (patch: Partial<SettingsRow> & { provider: string }) => Promise<SettingsRow | null>
    system: () => Promise<{ tier: number; cliAvailable: boolean; cliVersion: string | null }>
  }
  agentTasks: {
    list: (params?: { event_id?: string; task_type?: string; limit?: number }) => Promise<AgentTaskRow[]>
    create: (input: Partial<AgentTaskRow> & { event_id: string; task_type: string }) => Promise<AgentTaskRow>
  }
  me: {
    get: () => Promise<{ userId: string; email: string; full_name?: string | null; avatar_url?: string | null }>
    // Tier-0 only: web-UI signup / identity switch. POST /api/me { email }.
    // Tier-1 implementation throws — tier 1 uses Supabase magic-link auth.
    signup: (email: string) => Promise<{ userId: string; email: string; full_name?: string | null; avatar_url?: string | null }>
  }
  functions: {
    invoke: <T = unknown>(name: string, body?: unknown) => Promise<T>
  }
  realtime: {
    subscribeToStories: (cb: () => void) => () => void
  }
  practices: {
    list: (params?: { active_only?: boolean }) => Promise<PracticeRow[]>
    create: (input: Partial<PracticeRow> & { name: string; category: PracticeRow['category']; recurrence_mode: PracticeRow['recurrence_mode'] }) => Promise<PracticeRow>
    update: (id: string, patch: Partial<PracticeRow>) => Promise<PracticeRow>
    delete: (id: string) => Promise<void>
    markDone: (input: { practice_id: string; completed_on?: string; family_member_id?: string | null }) => Promise<void>
    unmarkDone: (input: { practice_id: string; completed_on: string; family_member_id?: string | null }) => Promise<void>
    completionsThisWeek: (date: string) => Promise<PracticeCompletionRow[]>
  }
  briefings: {
    getByDate: (date: string) => Promise<DailyBriefingRow | null>
    save: (input: { briefing_date: string; content_md: string; summary?: string | null; source: DailyBriefingRow['source'] }) => Promise<DailyBriefingRow>
  }
}
