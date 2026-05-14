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
  shared_with_family: boolean | null
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
  relationship_type: string
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

// ── DbClient interface ──────────────────────────────────────────────────────

export type DbClient = {
  events: {
    list: (params?: { limit?: number; from_date?: string; to_date?: string }) => Promise<EventRow[]>
    get: (id: string) => Promise<EventRow>
    create: (input: Partial<EventRow> & { title: string; start_date: string }) => Promise<EventRow>
    update: (id: string, patch: Partial<EventRow>) => Promise<EventRow>
    delete: (id: string) => Promise<void>
  }
  stories: {
    list: () => Promise<StoryRow[]>
    get: (id: string) => Promise<StoryRow | null>
    create: (input: Partial<StoryRow> & { title: string; body: string }) => Promise<StoryRow>
    update: (id: string, patch: Partial<StoryRow>) => Promise<StoryRow>
    delete: (id: string) => Promise<void>
  }
  memories: {
    list: (params?: { event_id?: string }) => Promise<MemoryRow[]>
    create: (input: Partial<MemoryRow> & { event_id: string }) => Promise<MemoryRow>
    update: (id: string, patch: Partial<MemoryRow>) => Promise<MemoryRow>
    delete: (id: string) => Promise<void>
    uploadFile: (params: { userId: string; filename: string; blob: Blob; contentType: string }) => Promise<{ key: string; publicUrl: string }>
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
    get: () => Promise<{ userId: string; email: string }>
  }
  functions: {
    invoke: <T = unknown>(name: string, body?: unknown) => Promise<T>
  }
  realtime: {
    subscribeToStories: (cb: () => void) => () => void
  }
}
