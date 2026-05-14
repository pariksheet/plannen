// Tier 0 (Plannen API) dbClient implementation. Talks to the local Hono
// backend through the Vite proxy. Maps each domain method to a REST route
// under /api/*, storage uploads to /storage/v1/object/event-photos/*, and
// edge functions to /functions/v1/*.

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

const BASE = '' // same-origin via Vite proxy

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({ error: { code: 'BAD_JSON', message: 'Non-JSON response' } }))
  if (!res.ok || body.error) {
    const msg = body?.error?.message ?? res.statusText
    throw new Error(msg)
  }
  return body.data as T
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const tier0: DbClient = {
  me: {
    get: () => api('/api/me'),
  },

  // ── events ────────────────────────────────────────────────────────────────
  events: {
    list: (p) =>
      api<EventRow[]>(`/api/events${qs({ limit: p?.limit, from_date: p?.from_date, to_date: p?.to_date })}`),
    get: (id) => api<EventRow>(`/api/events/${id}`),
    create: (i) => api<EventRow>('/api/events', { method: 'POST', body: JSON.stringify(i) }),
    update: (id, p) => api<EventRow>(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    delete: async (id) => { await api(`/api/events/${id}`, { method: 'DELETE' }) },
  },

  // ── stories ───────────────────────────────────────────────────────────────
  stories: {
    list: () => api<StoryRow[]>('/api/stories'),
    get: (id) => api<StoryRow | null>(`/api/stories/${id}`).catch((e: Error) => {
      if (/not found/i.test(e.message)) return null
      throw e
    }),
    create: (i) => api<StoryRow>('/api/stories', { method: 'POST', body: JSON.stringify(i) }),
    update: (id, p) => api<StoryRow>(`/api/stories/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    delete: async (id) => { await api(`/api/stories/${id}`, { method: 'DELETE' }) },
  },

  // ── memories ──────────────────────────────────────────────────────────────
  memories: {
    list: (p) => api<MemoryRow[]>(`/api/memories${qs({ event_id: p?.event_id })}`),
    create: (i) => api<MemoryRow>('/api/memories', { method: 'POST', body: JSON.stringify(i) }),
    update: (id, p) => api<MemoryRow>(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    delete: async (id) => { await api(`/api/memories/${id}`, { method: 'DELETE' }) },
    uploadFile: async ({ userId, filename, blob, contentType }) => {
      const path = `${userId}/${filename}`
      const res = await fetch(`/storage/v1/object/event-photos/${path}`, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': contentType },
      })
      const body = await res.json().catch(() => ({ error: { message: 'Non-JSON response' } }))
      if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
      return { key: body?.data?.Key ?? `event-photos/${path}`, publicUrl: `/storage/v1/object/public/event-photos/${path}` }
    },
  },

  // ── profile ───────────────────────────────────────────────────────────────
  profile: {
    get: () => api<ProfileRow | null>('/api/profile'),
    update: (patch) => api<ProfileRow | null>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
    listFacts: (params) =>
      api<FactRow[]>(`/api/profile/facts${qs({ subject: params?.subject, limit: params?.limit })}`),
    upsertFact: (fact) => api<FactRow>('/api/profile/facts', { method: 'POST', body: JSON.stringify(fact) }),
    deleteFact: async (id) => { await api(`/api/profile/facts/${id}`, { method: 'DELETE' }) },
  },

  // ── relationships ─────────────────────────────────────────────────────────
  relationships: {
    listFamilyMembers: () => api<FamilyMemberRow[]>('/api/relationships/family-members'),
    createFamilyMember: (input) =>
      api<FamilyMemberRow>('/api/relationships/family-members', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateFamilyMember: (id, patch) =>
      api<FamilyMemberRow>(`/api/relationships/family-members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteFamilyMember: async (id) => {
      await api(`/api/relationships/family-members/${id}`, { method: 'DELETE' })
    },
    listRelationships: () => api<RelationshipRow[]>('/api/relationships/relationships'),
  },

  // ── locations ─────────────────────────────────────────────────────────────
  locations: {
    list: () => api<LocationRow[]>('/api/locations'),
    create: (input) => api<LocationRow>('/api/locations', { method: 'POST', body: JSON.stringify(input) }),
    update: (id, patch) =>
      api<LocationRow>(`/api/locations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: async (id) => { await api(`/api/locations/${id}`, { method: 'DELETE' }) },
  },

  // ── sources ───────────────────────────────────────────────────────────────
  sources: {
    list: (params) => api<SourceRow[]>(`/api/sources${qs({ limit: params?.limit })}`),
    create: (input) => api<SourceRow>('/api/sources', { method: 'POST', body: JSON.stringify(input) }),
    update: (id, patch) =>
      api<SourceRow>(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  },

  // ── watch ─────────────────────────────────────────────────────────────────
  watch: {
    list: (params) =>
      api<WatchTaskRow[]>(`/api/watch${qs({ event_id: params?.event_id, status: params?.status })}`),
    create: (input) => api<WatchTaskRow>('/api/watch', { method: 'POST', body: JSON.stringify(input) }),
    update: (id, patch) =>
      api<WatchTaskRow>(`/api/watch/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: async (id) => { await api(`/api/watch/${id}`, { method: 'DELETE' }) },
  },

  // ── rsvp ──────────────────────────────────────────────────────────────────
  rsvp: {
    upsert: (input) => api<RsvpRow>('/api/rsvp', { method: 'POST', body: JSON.stringify(input) }),
  },

  // ── groups ────────────────────────────────────────────────────────────────
  groups: {
    list: () => api<GroupRow[]>('/api/groups'),
    create: (input) => api<GroupRow>('/api/groups', { method: 'POST', body: JSON.stringify(input) }),
    listInvites: (params) =>
      api<InviteRow[]>(`/api/groups/invites${qs({ event_id: params?.event_id })}`),
    createInvite: (input) =>
      api<InviteRow>('/api/groups/invites', { method: 'POST', body: JSON.stringify(input) }),
  },

  // ── wishlist ──────────────────────────────────────────────────────────────
  wishlist: {
    list: () => api<EventRow[]>('/api/wishlist'),
    create: (input) => api<EventRow>('/api/wishlist', { method: 'POST', body: JSON.stringify(input) }),
    delete: async (id) => { await api(`/api/wishlist/${id}`, { method: 'DELETE' }) },
  },

  // ── settings ──────────────────────────────────────────────────────────────
  settings: {
    get: () => api<SettingsRow | null>('/api/settings'),
    update: (patch) =>
      api<SettingsRow | null>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    system: () => api<{ tier: number; cliAvailable: boolean; cliVersion: string | null }>('/api/settings/system'),
  },

  // ── agentTasks ────────────────────────────────────────────────────────────
  agentTasks: {
    list: (params) =>
      api<AgentTaskRow[]>(
        `/api/agent-tasks${qs({ event_id: params?.event_id, task_type: params?.task_type, limit: params?.limit })}`,
      ),
    create: (input) => api<AgentTaskRow>('/api/agent-tasks', { method: 'POST', body: JSON.stringify(input) }),
  },

  // ── functions ─────────────────────────────────────────────────────────────
  // Edge functions return their own envelope shapes — pass through rather than
  // unwrapping a `data` key.
  functions: {
    invoke: async <T>(name: string, body?: unknown) => {
      const res = await fetch(`/functions/v1/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json().catch(() => ({ error: { message: 'Non-JSON response' } }))
      if (!res.ok) throw new Error(json?.error?.message ?? res.statusText)
      return json as T
    },
  },

  // ── realtime ──────────────────────────────────────────────────────────────
  // 30s polling fallback per the spec — no postgres_changes in Tier 0.
  realtime: {
    subscribeToStories: (cb) => {
      const id = setInterval(cb, 30_000)
      return () => clearInterval(id)
    },
  },
}
