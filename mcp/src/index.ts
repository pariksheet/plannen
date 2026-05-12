import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

// Load <repo-root>/.env before reading any process.env. Existing env vars (e.g.
// from `claude mcp add -e ...`) take precedence — dotenv only fills in gaps.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../.env') })

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { createClient } from '@supabase/supabase-js'
import {
  initialConfidence,
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
  type FactSource,
} from './profileFacts.js'
import { generateSessionDates, type RecurrenceRule } from './recurrence.js'
import { whisperAvailable, transcribeAudioBytes, extFromContentType } from './transcribe.js'
import { parseSourceUrl, normaliseTags, validateName, validateSourceType } from './sources.js'

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const USER_EMAIL = (process.env.PLANNEN_USER_EMAIL ?? '').toLowerCase()
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
// Convert a UTC ISO string to a local datetime string (no offset) for the given IANA timezone.
// e.g. "2026-05-10T09:00:00+00:00" + "Europe/Brussels" → "2026-05-10T11:00:00"
function toLocalIso(utcIso: string, tz: string): string {
  const d = new Date(utcIso)
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`
}

if (!SERVICE_ROLE_KEY) fatal('SUPABASE_SERVICE_ROLE_KEY is required')
if (!USER_EMAIL) fatal('PLANNEN_USER_EMAIL is required')

function fatal(msg: string): never {
  process.stderr.write(`[plannen-mcp] ${msg}\n`)
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'plannen' },
})

// ── User resolution ───────────────────────────────────────────────────────────

let _userId: string | null = null

async function uid(): Promise<string> {
  if (_userId) return _userId
  const { data, error } = await db.auth.admin.listUsers()
  if (error) throw new Error(`Auth error: ${error.message}`)
  const user = data.users.find((u) => u.email?.toLowerCase() === USER_EMAIL)
  if (!user) {
    throw new Error(
      `No Plannen account found for ${USER_EMAIL}. Sign in to the app at least once first.`
    )
  }
  _userId = user.id
  return _userId
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function extractDomain(url: string): string | null {
  let hostname: string
  try { hostname = new URL(url).hostname } catch { return null }
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null
  return hostname.replace(/^www\./, '')
}

// Columns returned by default for event reads — excludes image_url, created_at,
// updated_at, gcal_event_id, event_type, shared_with_*, enrollment_start_date,
// which are rarely needed by callers and balloon token usage.
const SLIM_EVENT_COLUMNS =
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id'

function slimEvent<T extends Record<string, unknown>>(e: T) {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? null,
    start_date: e.start_date,
    end_date: e.end_date,
    location: e.location,
    event_kind: e.event_kind,
    event_status: e.event_status,
    hashtags: e.hashtags,
    enrollment_url: e.enrollment_url,
    enrollment_deadline: e.enrollment_deadline,
  }
}

function truncateDescription(desc: unknown, maxLen = 200): string | null {
  if (typeof desc !== 'string') return null
  if (desc.length <= maxLen) return desc
  return desc.slice(0, maxLen) + '…'
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function listEvents(args: { status?: string; limit?: number; from_date?: string; to_date?: string; fields?: 'summary' | 'full' }) {
  const [id, tz] = await Promise.all([uid(), getUserTimezone()])
  let q = db
    .from('events')
    .select('id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline')
    .eq('created_by', id)
    .order('start_date', { ascending: true })
    .limit(args.limit ?? 10)
  if (args.status) q = q.eq('event_status', args.status)
  if (args.from_date) q = q.gte('start_date', args.from_date)
  if (args.to_date) q = q.lt('start_date', args.to_date + 'T24:00:00')
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const full = args.fields === 'full'
  return (data ?? []).map(e => ({
    ...e,
    description: full ? e.description : truncateDescription(e.description),
    start_date: e.start_date ? toLocalIso(e.start_date, tz) : e.start_date,
    end_date: e.end_date ? toLocalIso(e.end_date, tz) : e.end_date,
    user_timezone: tz,
  }))
}

async function getEvent(args: { id: string; fields?: 'summary' | 'full' }) {
  const [id, tz] = await Promise.all([uid(), getUserTimezone()])
  const selectCols = args.fields === 'full' ? '*' : SLIM_EVENT_COLUMNS
  const { data, error } = await db
    .from('events')
    .select(selectCols)
    .eq('id', args.id)
    .eq('created_by', id)
    .single<Record<string, unknown>>()
  if (error) throw new Error(error.message)

  const localise = (e: { start_date?: string | null; end_date?: string | null }) => ({
    ...e,
    start_date: e.start_date ? toLocalIso(e.start_date, tz) : e.start_date,
    end_date: e.end_date ? toLocalIso(e.end_date, tz) : e.end_date,
    user_timezone: tz,
  })

  const { data: memoryRows } = await db
    .from('event_memories')
    .select('id, external_id, source, caption')
    .eq('event_id', data.id)
  const memories = memoryRows ?? []

  // Recurring parent: embed sessions
  if (data.recurrence_rule) {
    const { data: sessions } = await db
      .from('events')
      .select('id, title, start_date, end_date, event_status')
      .eq('parent_event_id', data.id)
      .order('start_date', { ascending: true })
    return { ...localise(data), sessions: (sessions ?? []).map(localise), memories }
  }

  // Session: embed parent summary
  if (data.parent_event_id) {
    const { data: parent } = await db
      .from('events')
      .select('id, title, start_date, recurrence_rule')
      .eq('id', data.parent_event_id)
      .single()
    return { ...localise(data), parent: parent ? localise(parent) : null, memories }
  }

  return { ...data, memories }
}

const VALID_EVENT_STATUSES = ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'] as const
type EventStatus = typeof VALID_EVENT_STATUSES[number]

async function upsertSource(
  userId: string,
  eventId: string | null,
  enrollmentUrl: string
): Promise<{ id: string; last_analysed_at: string | null } | null> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return null
  const { data: src, error: srcErr } = await db
    .from('event_sources')
    .upsert(
      { user_id: userId, domain, source_url: enrollmentUrl },
      { onConflict: 'user_id,domain' }
    )
    .select('id, last_analysed_at')
    .single()
  if (srcErr || !src) return null
  if (eventId !== null) {
    await db.from('event_source_refs').upsert(
      { event_id: eventId, source_id: src.id, user_id: userId, ref_type: 'enrollment_url' },
      { onConflict: 'event_id,source_id' }
    )
  }
  return { id: src.id, last_analysed_at: src.last_analysed_at }
}

async function createEvent(args: {
  title: string
  description?: string
  start_date: string
  end_date?: string
  location?: string
  event_kind?: string
  enrollment_url?: string
  hashtags?: string[]
  event_status?: string
  recurrence_rule?: RecurrenceRule
}) {
  const id = await uid()
  const startDate = new Date(args.start_date)
  const event_status: EventStatus =
    args.event_status && VALID_EVENT_STATUSES.includes(args.event_status as EventStatus)
      ? (args.event_status as EventStatus)
      : startDate < new Date() ? 'past' : 'going'

  const { data, error } = await db
    .from('events')
    .insert({
      title: args.title,
      description: args.description ?? null,
      start_date: args.start_date,
      end_date: args.end_date ?? null,
      location: args.location ?? null,
      event_kind: args.event_kind === 'reminder' ? 'reminder' : 'event',
      enrollment_url: args.enrollment_url ?? null,
      hashtags: (args.hashtags ?? []).slice(0, 5),
      event_type: 'personal',
      event_status,
      created_by: id,
      shared_with_family: false,
      shared_with_friends: 'none',
      recurrence_rule: args.recurrence_rule ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)

  if (data && args.recurrence_rule) {
    const tz = await getUserTimezone()
    const dates = generateSessionDates(args.start_date, args.recurrence_rule, tz)
    if (dates.length) {
      const sessions = dates.map((d, i) => ({
        title: `${args.title} – Session ${i + 1}`,
        description: args.description ?? null,
        start_date: d.start.toISOString(),
        end_date: d.end ? d.end.toISOString() : null,
        location: args.location ?? null,
        event_kind: 'session',
        event_type: 'personal',
        event_status,
        created_by: id,
        parent_event_id: data.id,
        shared_with_family: false,
        shared_with_friends: 'none',
        hashtags: (args.hashtags ?? []).slice(0, 5),
      }))
      await db.from('events').insert(sessions)
    }
  }

  const source = data && args.enrollment_url
    ? await upsertSource(id, data.id, args.enrollment_url)
    : null

  return { ...slimEvent(data), source }
}

async function updateEvent(args: {
  id: string
  title?: string
  description?: string
  start_date?: string
  end_date?: string
  location?: string
  event_status?: string
  enrollment_url?: string
}) {
  const id = await uid()
  const { id: _id, ...rest } = args
  const payload = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined)
  )
  const { data, error } = await db
    .from('events')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', args.id)
    .eq('created_by', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  const source = data?.enrollment_url
    ? await upsertSource(id, args.id, data.enrollment_url)
    : null
  return { ...slimEvent(data), source }
}

async function rsvpEvent(args: { event_id: string; status: string }) {
  const id = await uid()
  const { error } = await db
    .from('event_rsvps')
    .upsert(
      { event_id: args.event_id, user_id: id, status: args.status },
      { onConflict: 'event_id,user_id' }
    )
  if (error) throw new Error(error.message)
  return { success: true, event_id: args.event_id, status: args.status }
}

async function addEventMemory(args: {
  event_id: string
  external_id: string
  source?: 'google_photos' | 'google_drive'
  caption?: string
  media_type?: 'image' | 'video' | 'audio'
}) {
  const id = await uid()
  const source = args.source ?? 'google_photos'
  const mediaType = (args.media_type as 'image' | 'video' | 'audio' | undefined) ?? 'image'
  const { data, error } = await db
    .from('event_memories')
    .upsert(
      {
        event_id: args.event_id,
        user_id: id,
        media_url: null,
        media_type: mediaType,
        source,
        external_id: args.external_id,
        caption: args.caption ?? null,
      },
      { onConflict: 'event_id,external_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return { attached: !!data, id: data?.id ?? null, event_id: args.event_id, external_id: args.external_id }
}

async function listEventMemories(args: { event_id: string }) {
  const userId = await uid()
  const { data: event, error: evtErr } = await db
    .from('events')
    .select('id, created_by')
    .eq('id', args.event_id)
    .single()
  if (evtErr) throw new Error(evtErr.message)
  if (event.created_by !== userId) throw new Error('Event not found')
  const { data, error } = await db
    .from('event_memories')
    .select('id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at')
    .eq('event_id', args.event_id)
    .order('taken_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

async function transcribeMemory(args: { memory_id: string; force?: boolean }) {
  await uid() // ensure auth scope (also throws on missing user)
  const { data: row, error } = await db
    .from('event_memories')
    .select('id, media_type, media_url, transcript, transcript_lang')
    .eq('id', args.memory_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!row) throw new Error('memory not found')
  if (row.media_type !== 'audio') {
    return { ok: false as const, error: 'unsupported_media_type', detail: `media_type=${row.media_type}` }
  }
  if (row.transcript && !args.force) {
    return {
      ok: true as const, cached: true,
      transcript: row.transcript,
      language: row.transcript_lang ?? 'en',
    }
  }
  if (!await whisperAvailable()) {
    return { ok: false as const, error: 'whisper_not_installed' }
  }
  if (!row.media_url) {
    return { ok: false as const, error: 'fetch_failed', detail: 'media_url is null' }
  }

  let bytes: Uint8Array
  let contentType: string | undefined
  try {
    const res = await fetch(row.media_url)
    if (!res.ok) return { ok: false as const, error: 'fetch_failed', detail: `HTTP ${res.status}` }
    contentType = res.headers.get('content-type') ?? undefined
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    return { ok: false as const, error: 'fetch_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  let transcript: string, language: string
  try {
    const out = await transcribeAudioBytes(bytes, { contentType, ext: extFromContentType(contentType) ?? undefined })
    transcript = out.transcript; language = out.language
  } catch (e) {
    return { ok: false as const, error: 'whisper_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  const { error: updErr } = await db
    .from('event_memories')
    .update({ transcript, transcript_lang: language, transcribed_at: new Date().toISOString() })
    .eq('id', args.memory_id)
  if (updErr) throw new Error(updErr.message)

  return { ok: true as const, cached: false, transcript, language }
}

async function createStory(args: {
  event_ids?: string[]
  title: string
  body: string
  user_notes?: string
  mood?: string
  tone?: string
  cover_url?: string
  date_from?: string
  date_to?: string
  language?: string                    // NEW
  story_group_id?: string              // NEW
}) {
  const userId = await uid()
  const eventIds = args.event_ids ?? []
  if (!args.title?.trim()) throw new Error('title is required')
  if (!args.body?.trim()) throw new Error('body is required')
  if (!eventIds.length && !(args.date_from && args.date_to)) {
    throw new Error('Provide event_ids or both date_from and date_to')
  }

  if (eventIds.length) {
    const { data: events, error: evtErr } = await db
      .from('events')
      .select('id, created_by')
      .in('id', eventIds)
    if (evtErr) throw new Error(evtErr.message)
    const ownedIds = new Set((events ?? []).filter(e => e.created_by === userId).map(e => e.id))
    const missing = eventIds.filter(id => !ownedIds.has(id))
    if (missing.length) throw new Error(`Events not found or not owned: ${missing.join(', ')}`)
  }

  if (eventIds.length === 1) {
    const lang = args.language ?? 'en'
    const { data: existing } = await db
      .from('story_events')
      .select('story_id, stories!inner(id, user_id, language)')
      .eq('event_id', eventIds[0])
      .eq('stories.user_id', userId)
      .eq('stories.language', lang)
      .maybeSingle()
    if (existing?.story_id) {
      const updatePatch: Record<string, unknown> = {
        title: args.title,
        body: args.body,
        user_notes: args.user_notes ?? null,
        mood: args.mood ?? null,
        tone: args.tone ?? null,
        generated_at: new Date().toISOString(),
      }
      if (args.cover_url !== undefined) updatePatch.cover_url = args.cover_url
      if (args.story_group_id) updatePatch.story_group_id = args.story_group_id
      const { data, error } = await db
        .from('stories')
        .update(updatePatch)
        .eq('id', existing.story_id)
        .select('id, story_group_id, language')
        .single()
      if (error) throw new Error(error.message)
      return { id: data.id, story_group_id: data.story_group_id, language: data.language, overwritten: true }
    }
  }

  let coverUrl = args.cover_url ?? null
  if (!coverUrl && eventIds.length) {
    const { data: mem } = await db
      .from('event_memories')
      .select('media_url, media_type, taken_at, created_at')
      .in('event_id', eventIds)
      .not('media_url', 'is', null)
      .eq('media_type', 'image')          // covers stay image-only
      .order('taken_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1)
    coverUrl = mem?.[0]?.media_url ?? null
  }

  const insertPayload: Record<string, unknown> = {
    user_id: userId,
    title: args.title,
    body: args.body,
    cover_url: coverUrl,
    user_notes: args.user_notes ?? null,
    mood: args.mood ?? null,
    tone: args.tone ?? null,
    date_from: args.date_from ?? null,
    date_to: args.date_to ?? null,
    language: args.language ?? 'en',
  }
  if (args.story_group_id) insertPayload.story_group_id = args.story_group_id

  const { data: story, error: insErr } = await db
    .from('stories')
    .insert(insertPayload)
    .select('id, story_group_id, language')
    .single()
  if (insErr) throw new Error(insErr.message)

  if (eventIds.length) {
    const links = eventIds.map(event_id => ({ story_id: story.id, event_id }))
    const { error: linkErr } = await db.from('story_events').insert(links)
    if (linkErr) throw new Error(linkErr.message)
  }

  return { id: story.id, story_group_id: story.story_group_id, language: story.language, overwritten: false }
}

async function updateStory(args: {
  id: string
  title?: string
  body?: string
  cover_url?: string
}) {
  const userId = await uid()
  const patch: Record<string, unknown> = {}
  if (args.title !== undefined) patch.title = args.title
  if (args.body !== undefined) patch.body = args.body
  if (args.cover_url !== undefined) patch.cover_url = args.cover_url
  if (Object.keys(patch).length === 0) throw new Error('No fields to update')
  const { data: story, error } = await db
    .from('stories')
    .update(patch)
    .eq('id', args.id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  const { data: links } = await db
    .from('story_events')
    .select('events:event_id(id, title, start_date)')
    .eq('story_id', story.id)
  const events = (links ?? [])
    .map(l => (l as unknown as { events: { id: string; title: string | null; start_date: string | null } | null }).events)
    .filter((e): e is { id: string; title: string | null; start_date: string | null } => !!e)
  return { ...story, events }
}

async function getStory(args: { id: string }) {
  const userId = await uid()
  const { data: story, error } = await db
    .from('stories')
    .select('*')
    .eq('id', args.id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!story) return null
  const { data: events } = await db
    .from('story_events')
    .select('events:event_id(id, title, start_date)')
    .eq('story_id', story.id)
  const { data: siblings } = await db
    .from('stories')
    .select('id, language')
    .eq('story_group_id', story.story_group_id)
    .order('generated_at', { ascending: true })
  const eventList = (events ?? []).map(r => r.events).filter(Boolean)
  return { ...story, events: eventList, siblings: siblings ?? [] }
}

async function listStories(args: { limit?: number; offset?: number } = {}) {
  const userId = await uid()
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  const { data, error } = await db
    .from('stories')
    .select('*, story_events(events:event_id(id, title, start_date))')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return (data ?? []).map(row => {
    const events = ((row.story_events ?? []) as Array<{ events: { id: string; title: string | null; start_date: string | null } | null }>)
      .map(l => l.events)
      .filter((e): e is { id: string; title: string | null; start_date: string | null } => !!e)
    const { story_events: _ignore, ...rest } = row as Record<string, unknown>
    return { ...rest, events }
  })
}

async function deleteStory(args: { id: string }) {
  const userId = await uid()
  const { error } = await db
    .from('stories')
    .delete()
    .eq('id', args.id)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return { success: true }
}

async function getGoogleAccessToken(): Promise<string> {
  const userId = await uid()
  const { data: row, error } = await db
    .from('user_oauth_tokens')
    .select('access_token, expires_at, refresh_token')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!row) throw new Error('Google not connected. Connect Google in the Plannen UI first (Settings → Connect Google).')
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null
  const fresh = row.access_token && expiresAt && expiresAt.getTime() - Date.now() > 5 * 60 * 1000
  if (fresh && row.access_token) return row.access_token
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in MCP env to refresh tokens')
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
    }).toString(),
  })
  if (!tokenRes.ok) throw new Error(`Google token refresh failed: ${tokenRes.status} ${await tokenRes.text()}`)
  const tokens = (await tokenRes.json()) as { access_token: string; expires_in: number }
  await db.from('user_oauth_tokens').update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('provider', 'google')
  return tokens.access_token
}

async function createPhotoPickerSession() {
  const accessToken = await getGoogleAccessToken()
  const res = await fetch('https://photospicker.googleapis.com/v1/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`Failed to create picker session: ${res.status} ${await res.text()}`)
  const session = (await res.json()) as { id: string; pickerUri: string; expireTime?: string; mediaItemsSet?: boolean }
  return {
    session_id: session.id,
    picker_uri: session.pickerUri,
    expires_at: session.expireTime ?? null,
    instructions: 'Open picker_uri in a browser, select photos for the event, then call poll_photo_picker_session with the session_id and event_id.',
  }
}

interface PickedMediaItem {
  id?: string
  type?: string
  createTime?: string
  mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string }
}

const PICKER_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

async function pollPhotoPickerSession(args: { session_id: string; event_id: string }) {
  const userId = await uid()
  const accessToken = await getGoogleAccessToken()

  const sessionRes = await fetch(
    `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(args.session_id)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!sessionRes.ok) throw new Error(`Failed to fetch session: ${sessionRes.status} ${await sessionRes.text()}`)
  const session = (await sessionRes.json()) as { mediaItemsSet?: boolean }
  if (!session.mediaItemsSet) return { status: 'pending' as const }

  const items: PickedMediaItem[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ sessionId: args.session_id, pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const listRes = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!listRes.ok) throw new Error(`Failed to list picker items: ${listRes.status} ${await listRes.text()}`)
    const page = (await listRes.json()) as { mediaItems?: PickedMediaItem[]; nextPageToken?: string }
    if (page.mediaItems) items.push(...page.mediaItems)
    pageToken = page.nextPageToken
  } while (pageToken)

  const attached: { external_id: string; memory_id: string; filename?: string; already?: boolean }[] = []
  const skipped: { external_id: string; reason: string }[] = []

  for (const item of items) {
    if (!item.id || !item.mediaFile?.baseUrl) {
      skipped.push({ external_id: item.id ?? '', reason: 'missing id or baseUrl' })
      continue
    }
    if (item.type && item.type !== 'PHOTO') {
      skipped.push({ external_id: item.id, reason: `unsupported type ${item.type}` })
      continue
    }

    const { data: existing } = await db
      .from('event_memories')
      .select('id')
      .eq('event_id', args.event_id)
      .eq('external_id', item.id)
      .maybeSingle()
    if (existing) {
      attached.push({ external_id: item.id, memory_id: existing.id, filename: item.mediaFile.filename, already: true })
      continue
    }

    const bytesRes = await fetch(`${item.mediaFile.baseUrl}=d`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!bytesRes.ok) {
      skipped.push({ external_id: item.id, reason: `download failed ${bytesRes.status}` })
      continue
    }
    const blob = await bytesRes.blob()
    const mimeType = item.mediaFile.mimeType ?? bytesRes.headers.get('Content-Type') ?? 'image/jpeg'
    const ext = PICKER_MIME_TO_EXT[mimeType.toLowerCase()] ?? 'jpg'
    const path = `${args.event_id}/${userId}/${item.id}.${ext}`

    const { error: uploadError } = await db.storage
      .from('event-photos')
      .upload(path, blob, { upsert: true, contentType: mimeType })
    if (uploadError) {
      skipped.push({ external_id: item.id, reason: `upload failed: ${uploadError.message}` })
      continue
    }
    const { data: { publicUrl } } = db.storage.from('event-photos').getPublicUrl(path)

    const { data: inserted, error: insertError } = await db
      .from('event_memories')
      .insert({
        event_id: args.event_id,
        user_id: userId,
        source: 'google_photos',
        external_id: item.id,
        media_url: publicUrl,
        media_type: 'image',
        taken_at: item.createTime ?? null,
      })
      .select('id')
      .single()
    if (insertError || !inserted) {
      skipped.push({ external_id: item.id, reason: `insert failed: ${insertError?.message ?? 'unknown'}` })
      continue
    }
    attached.push({ external_id: item.id, memory_id: inserted.id, filename: item.mediaFile.filename })
  }

  return { status: 'complete' as const, attached, skipped, total_selected: items.length }
}

async function getUserTimezone(): Promise<string> {
  const id = await uid()
  const { data } = await db.from('user_profiles').select('timezone').eq('user_id', id).maybeSingle()
  return data?.timezone ?? 'UTC'
}

async function getGcalSyncCandidates() {
  const [id, tz] = await Promise.all([uid(), getUserTimezone()])

  // Get all going events without a gcal_event_id
  const { data: events, error } = await db
    .from('events')
    .select('id, title, description, start_date, end_date, location, event_kind, hashtags, enrollment_url')
    .eq('created_by', id)
    .eq('event_status', 'going')
    .is('gcal_event_id', null)
    .is('recurrence_rule', null)
    .order('start_date', { ascending: true })
  if (error) throw new Error(error.message)
  if (!events?.length) return []

  const ids = events.map((e) => e.id)
  const { data: rsvps } = await db
    .from('event_rsvps')
    .select('event_id, preferred_visit_date')
    .eq('user_id', id)
    .in('event_id', ids)
  const visitMap = Object.fromEntries((rsvps ?? []).map((r) => [r.event_id, r.preferred_visit_date]))

  return events.map((e) => {
    const preferredDate: string | null = visitMap[e.id] ?? null
    const isMultiDay = !!e.end_date && e.start_date.slice(0, 10) !== e.end_date.slice(0, 10)
    const useVisitDate = preferredDate && isMultiDay

    const gcal_start = useVisitDate
      ? `${preferredDate}T00:00:00`
      : toLocalIso(e.start_date, tz)
    const gcal_end = useVisitDate
      ? `${preferredDate}T23:59:59`
      : (e.end_date ? toLocalIso(e.end_date, tz) : null)

    return {
      id: e.id,
      title: e.title,
      description: e.description,
      location: e.location,
      enrollment_url: e.enrollment_url,
      event_kind: e.event_kind,
      gcal_start,
      gcal_end,
      gcal_timezone: tz,
      preferred_visit_date: preferredDate,
    }
  })
}

async function setGcalEventId(args: { event_id: string; gcal_event_id: string | null }) {
  const id = await uid()
  const { error } = await db
    .from('events')
    .update({ gcal_event_id: args.gcal_event_id })
    .eq('id', args.event_id)
    .eq('created_by', id)
  if (error) throw new Error(error.message)
  return { success: true, event_id: args.event_id, gcal_event_id: args.gcal_event_id }
}

async function listRelationships(args: { type?: string }) {
  const id = await uid()
  const types =
    args.type === 'family' ? ['family', 'both']
    : args.type === 'friend' ? ['friend', 'both']
    : ['family', 'friend', 'both']

  const { data: rels, error } = await db
    .from('relationships')
    .select('user_id, related_user_id, relationship_type')
    .or(`user_id.eq.${id},related_user_id.eq.${id}`)
    .eq('status', 'accepted')
    .in('relationship_type', types)
  if (error) throw new Error(error.message)

  const otherIds = (rels ?? []).map((r) =>
    r.user_id === id ? r.related_user_id : r.user_id
  )
  if (!otherIds.length) return []

  const { data: users, error: ue } = await db
    .from('users')
    .select('id, full_name, email')
    .in('id', otherIds)
  if (ue) throw new Error(ue.message)

  return (rels ?? []).map((r) => {
    const otherId = r.user_id === id ? r.related_user_id : r.user_id
    const person = (users ?? []).find((u) => u.id === otherId)
    return {
      id: otherId,
      full_name: person?.full_name ?? null,
      email: person?.email ?? null,
      relationship_type: r.relationship_type,
    }
  })
}

// ── Profile tools ─────────────────────────────────────────────────────────────

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  const today = new Date()
  const age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) return age - 1
  return age
}

async function getProfileContext(args: { include_historical?: boolean } = {}) {
  const id = await uid()
  const [profileRes, locationsRes, familyRes, factsRes, historicalRes] = await Promise.all([
    db.from('user_profiles').select('dob, goals, interests, timezone').eq('user_id', id).maybeSingle(),
    db.from('user_locations').select('label, city, country, is_default').eq('user_id', id).order('created_at', { ascending: true }),
    db.from('family_members').select('id, name, relation, dob, gender, goals, interests').eq('user_id', id).order('created_at', { ascending: true }),
    db.from('profile_facts').select('subject, predicate, value, confidence, source').eq('user_id', id).eq('is_historical', false).gte('confidence', 0.6).order('subject').order('predicate'),
    args.include_historical
      ? db.from('profile_facts').select('subject, predicate, value, confidence').eq('user_id', id).eq('is_historical', true).order('subject').order('last_seen_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ])
  if (profileRes.error) throw new Error(profileRes.error.message)
  if (locationsRes.error) throw new Error(locationsRes.error.message)
  if (familyRes.error) throw new Error(familyRes.error.message)
  if (factsRes.error) throw new Error(factsRes.error.message)
  if (historicalRes.error) throw new Error(historicalRes.error.message)

  return {
    goals: profileRes.data?.goals ?? [],
    interests: profileRes.data?.interests ?? [],
    timezone: profileRes.data?.timezone ?? 'UTC',
    locations: (locationsRes.data ?? []).map((l) => ({
      label: l.label,
      city: l.city,
      country: l.country,
      is_default: l.is_default,
    })),
    family_members: (familyRes.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      relation: m.relation,
      age: computeAge(m.dob),
      gender: m.gender,
      goals: m.goals,
      interests: m.interests,
    })),
    profile_facts: factsRes.data ?? [],
    historical_facts: args.include_historical ? (historicalRes.data ?? []) : undefined,
  }
}

async function updateProfile(args: { dob?: string | null; goals?: string[]; interests?: string[]; timezone?: string }) {
  const id = await uid()
  const payload: Record<string, unknown> = { user_id: id }
  if (args.dob !== undefined) payload.dob = args.dob
  if (args.goals !== undefined) payload.goals = args.goals
  if (args.interests !== undefined) payload.interests = args.interests
  if (args.timezone !== undefined) payload.timezone = args.timezone
  const { error } = await db
    .from('user_profiles')
    .upsert(payload, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return { success: true }
}

async function getStoryLanguagesHandler() {
  const id = await uid()
  const { data, error } = await db
    .from('user_profiles')
    .select('story_languages')
    .eq('user_id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const langs = (data?.story_languages as string[] | null | undefined) ?? ['en']
  return { languages: langs.length ? langs : ['en'] }
}

const ALLOWED_LANG_CODES = new Set(['en','nl','fr','de','es','it','pt','hi','mr','ja','zh','ar'])

async function setStoryLanguagesHandler(args: { languages: string[] }) {
  if (!Array.isArray(args.languages) || args.languages.length === 0) {
    throw new Error('languages must be a non-empty array')
  }
  if (args.languages.length > 3) throw new Error('Maximum 3 languages.')
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const c of args.languages) {
    if (!ALLOWED_LANG_CODES.has(c)) throw new Error(`Unknown language: ${c}`)
    if (!seen.has(c)) { seen.add(c); cleaned.push(c) }
  }
  const id = await uid()
  const { error } = await db
    .from('user_profiles')
    .upsert({ user_id: id, story_languages: cleaned }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return { languages: cleaned }
}

async function addFamilyMember(args: {
  name: string
  relation: string
  dob?: string | null
  gender?: string | null
  goals?: string[]
  interests?: string[]
}) {
  const id = await uid()
  const { data, error } = await db
    .from('family_members')
    .insert({ user_id: id, ...args, goals: args.goals ?? [], interests: args.interests ?? [] })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function listFamilyMembers() {
  const id = await uid()
  const { data, error } = await db
    .from('family_members')
    .select('id, name, relation, dob, gender, goals, interests')
    .eq('user_id', id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((m) => ({ ...m, age: computeAge(m.dob) }))
}

async function addLocation(args: {
  label: string
  address?: string
  city?: string
  country?: string
  is_default?: boolean
}) {
  const id = await uid()
  if (args.is_default) {
    const { error: clearErr } = await db
      .from('user_locations').update({ is_default: false }).eq('user_id', id)
    if (clearErr) throw new Error(clearErr.message)
  }
  const { data, error } = await db
    .from('user_locations')
    .insert({
      user_id: id,
      label: args.label,
      address: args.address ?? '',
      city: args.city ?? '',
      country: args.country ?? '',
      is_default: args.is_default ?? false,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function listLocations() {
  const id = await uid()
  const { data, error } = await db
    .from('user_locations')
    .select('id, label, address, city, country, is_default')
    .eq('user_id', id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Watch monitoring tools ────────────────────────────────────────────────────

async function getEventWatchTask(args: { event_id: string }) {
  const id = await uid()
  const { data, error } = await db
    .from('agent_tasks')
    .select('id, event_id, task_type, status, next_check, last_checked_at, last_result, fail_count, has_unread_update, update_summary, recurrence_months, last_occurrence_date')
    .eq('event_id', args.event_id)
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)

  // Verify the event belongs to this user
  if (data) {
    const { data: event, error: evErr } = await db
      .from('events')
      .select('id')
      .eq('id', data.event_id)
      .eq('created_by', id)
      .maybeSingle()
    if (evErr) throw new Error(evErr.message)
    if (!event) return null
  }
  return data ?? null
}

async function getWatchQueue() {
  const id = await uid()
  const now = new Date().toISOString()

  // Step 1: get IDs of all events owned by this user
  const { data: userEvents, error: evErr } = await db
    .from('events')
    .select('id, title, enrollment_url, start_date')
    .eq('created_by', id)
  if (evErr) throw new Error(evErr.message)
  const eventIds = (userEvents ?? []).map((e) => e.id)
  if (!eventIds.length) return []

  // Step 2: get due tasks for those events
  const { data, error } = await db
    .from('agent_tasks')
    .select('id, event_id, task_type, last_result, last_page_hash, last_checked_at, recurrence_months, last_occurrence_date')
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .eq('status', 'active')
    .lte('next_check', now)
    .in('event_id', eventIds)
  if (error) throw new Error(error.message)

  const eventMap = new Map((userEvents ?? []).map((e) => [e.id, e]))
  return (data ?? []).map((task) => {
    const event = eventMap.get(task.event_id)
    return {
      id: task.id,
      event_id: task.event_id,
      event_title: event?.title ?? null,
      enrollment_url: event?.enrollment_url ?? null,
      start_date: event?.start_date ?? null,
      task_type: task.task_type,
      last_result: task.last_result,
      last_page_hash: task.last_page_hash,
      last_checked_at: task.last_checked_at,
      recurrence_months: task.recurrence_months,
      last_occurrence_date: task.last_occurrence_date,
    }
  })
}

async function updateWatchTask(args: {
  task_id: string
  last_result: Record<string, unknown>
  last_page_hash: string
  next_check: string
  fail_count: number
  has_unread_update: boolean
  update_summary?: string
  status?: 'active' | 'failed'
  recurrence_months?: number
  last_occurrence_date?: string
}) {
  const id = await uid()
  const { data: ownership, error: ownerErr } = await db
    .from('agent_tasks')
    .select('event_id')
    .eq('id', args.task_id)
    .maybeSingle()
  if (ownerErr) throw new Error(ownerErr.message)
  if (!ownership) throw new Error('Watch task not found')
  const { data: ownedEvent, error: ownedErr } = await db
    .from('events')
    .select('id')
    .eq('id', ownership.event_id)
    .eq('created_by', id)
    .maybeSingle()
  if (ownedErr) throw new Error(ownedErr.message)
  if (!ownedEvent) throw new Error('Not authorised to update this watch task')

  const payload: Record<string, unknown> = {
    last_result: args.last_result,
    last_page_hash: args.last_page_hash,
    last_checked_at: new Date().toISOString(),
    next_check: args.next_check,
    fail_count: args.fail_count,
    has_unread_update: args.has_unread_update,
    updated_at: new Date().toISOString(),
  }
  if (args.update_summary !== undefined) payload.update_summary = args.update_summary
  if (args.status !== undefined) payload.status = args.status
  if (args.recurrence_months !== undefined) payload.recurrence_months = args.recurrence_months
  if (args.last_occurrence_date !== undefined) payload.last_occurrence_date = args.last_occurrence_date

  const { error } = await db
    .from('agent_tasks')
    .update(payload)
    .eq('id', args.task_id)
  if (error) throw new Error(error.message)
  return { success: true }
}

async function createWatchTask(args: {
  event_id: string
  recurrence_months?: number
  last_occurrence_date?: string
}) {
  const id = await uid()
  const { data: event, error: evErr } = await db
    .from('events')
    .select('id')
    .eq('id', args.event_id)
    .eq('created_by', id)
    .maybeSingle()
  if (evErr) throw new Error(evErr.message)
  if (!event) throw new Error('Event not found or not authorised')

  const payload: Record<string, unknown> = {
    event_id: args.event_id,
    task_type: 'recurring_check',
    status: 'active',
    next_check: new Date().toISOString(),
  }
  if (args.recurrence_months !== undefined) payload.recurrence_months = args.recurrence_months
  if (args.last_occurrence_date !== undefined) payload.last_occurrence_date = args.last_occurrence_date

  const { data, error } = await db
    .from('agent_tasks')
    .upsert(payload, { onConflict: 'event_id,task_type' })
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return { success: true, task_id: data?.id }
}

// ── Source intelligence tools ─────────────────────────────────────────────────

async function updateSource(args: {
  id: string
  name: string
  tags: string[]
  source_type: 'platform' | 'organiser' | 'one_off'
}) {
  const id = await uid()
  const { data: source, error: fetchErr } = await db
    .from('event_sources')
    .select('id')
    .eq('id', args.id)
    .eq('user_id', id)
    .maybeSingle()
  if (fetchErr) throw new Error(fetchErr.message)
  if (!source) throw new Error('Source not found')
  const { error } = await db
    .from('event_sources')
    .update({
      name: args.name,
      tags: args.tags.slice(0, 10),
      source_type: args.source_type,
      last_analysed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.id)
  if (error) throw new Error(error.message)
  return { success: true }
}

async function saveSource(args: {
  url: string
  name: string
  tags: string[]
  source_type: string
}) {
  const { domain, sourceUrl } = parseSourceUrl(args.url)
  const name = validateName(args.name)
  const tags = normaliseTags(args.tags)
  const source_type = validateSourceType(args.source_type)

  const userId = await uid()

  // Detect whether the row pre-existed so we can label the action.
  const { data: existing, error: existingErr } = await db
    .from('event_sources')
    .select('id')
    .eq('user_id', userId)
    .eq('domain', domain)
    .maybeSingle()
  if (existingErr) throw new Error(existingErr.message)
  const action: 'inserted' | 'updated' = existing ? 'updated' : 'inserted'

  const upserted = await upsertSource(userId, null, sourceUrl)
  if (!upserted) throw new Error('failed to upsert source')

  const { error } = await db
    .from('event_sources')
    .update({
      name,
      tags,
      source_type,
      last_analysed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', upserted.id)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)

  return { id: upserted.id, domain, action }
}

async function getUnanalysedSources() {
  const id = await uid()
  const { data, error } = await db
    .from('event_sources')
    .select('id, domain, source_url')
    .eq('user_id', id)
    .is('last_analysed_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

async function searchSources(args: { tags: string[] }) {
  const id = await uid()
  if (!args.tags.length) return []
  const { data, error } = await db
    .from('event_sources')
    .select('id, domain, source_url, name, tags, source_type')
    .eq('user_id', id)
    .overlaps('tags', args.tags)
    .not('last_analysed_at', 'is', null)
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Profile facts tools ───────────────────────────────────────────────────────

async function upsertProfileFact(args: {
  subject: string
  predicate: string
  value: string
  source: FactSource
}) {
  const id = await uid()
  const { data: existing } = await db
    .from('profile_facts')
    .select('id, value, confidence, observed_count')
    .eq('user_id', id)
    .eq('subject', args.subject)
    .eq('predicate', args.predicate)
    .eq('is_historical', false)
    .maybeSingle()

  if (!existing) {
    const { error } = await db.from('profile_facts').insert({
      user_id: id,
      subject: args.subject,
      predicate: args.predicate,
      value: args.value,
      confidence: initialConfidence(args.source),
      observed_count: 1,
      source: args.source,
    })
    if (error) throw new Error(error.message)
    return { action: 'inserted' }
  }

  if (existing.value === args.value) {
    const newConfidence = computeCorroborationConfidence(existing.confidence)
    const { error } = await db
      .from('profile_facts')
      .update({ confidence: newConfidence, observed_count: existing.observed_count + 1, last_seen_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
    return { action: 'corroborated', confidence: newConfidence }
  }

  const decayedConfidence = computeContradictionConfidence(existing.confidence)
  const { error: decayErr } = await db
    .from('profile_facts')
    .update({ confidence: decayedConfidence, is_historical: shouldMarkHistorical(decayedConfidence) })
    .eq('id', existing.id)
  if (decayErr) throw new Error(decayErr.message)

  const { error: insertErr } = await db.from('profile_facts').insert({
    user_id: id,
    subject: args.subject,
    predicate: args.predicate,
    value: args.value,
    confidence: initialConfidence(args.source),
    observed_count: 1,
    source: args.source,
  })
  if (insertErr) throw new Error(insertErr.message)
  return { action: 'contradicted', old_value: existing.value, new_value: args.value }
}

async function correctProfileFact(args: {
  subject: string
  predicate: string
  old_value: string
  new_value: string
}) {
  const id = await uid()
  const { data: existing, error: fetchErr } = await db
    .from('profile_facts')
    .select('id')
    .eq('user_id', id)
    .eq('subject', args.subject)
    .eq('predicate', args.predicate)
    .eq('value', args.old_value)
    .eq('is_historical', false)
    .maybeSingle()
  if (fetchErr) throw new Error(fetchErr.message)

  if (existing) {
    const { error: markErr } = await db
      .from('profile_facts')
      .update({ is_historical: true })
      .eq('id', existing.id)
    if (markErr) throw new Error(markErr.message)
  }

  const { error: insertErr } = await db.from('profile_facts').insert({
    user_id: id,
    subject: args.subject,
    predicate: args.predicate,
    value: args.new_value,
    confidence: 1.0,
    observed_count: 1,
    source: 'user_stated' as FactSource,
  })
  if (insertErr) throw new Error(insertErr.message)
  return { action: 'corrected', old_value: args.old_value, new_value: args.new_value }
}

async function listProfileFacts(args: { subject?: string }) {
  const id = await uid()
  let query = db
    .from('profile_facts')
    .select('subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at')
    .eq('user_id', id)
    .eq('is_historical', false)
    .gte('confidence', 0.6)
    .order('subject', { ascending: true })
    .order('predicate', { ascending: true })
  if (args.subject) query = query.eq('subject', args.subject)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

async function getHistoricalFacts(args: { subject?: string }) {
  const id = await uid()
  let query = db
    .from('profile_facts')
    .select('subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at')
    .eq('user_id', id)
    .eq('is_historical', true)
    .order('subject', { ascending: true })
    .order('last_seen_at', { ascending: false })
  if (args.subject) query = query.eq('subject', args.subject)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'list_events',
    description: 'List your events in Plannen. Returns a slim row by default; description is truncated to 200 chars + ellipsis. Pass fields:"full" if you need the untruncated description.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'],
          description: 'Filter by status (omit for all)',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
        from_date: { type: 'string', description: 'ISO date to filter events starting on or after this date, e.g. 2026-05-07' },
        to_date: { type: 'string', description: 'ISO date to filter events starting on or before this date, e.g. 2026-05-07' },
        fields: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) truncates description to 200 chars; full returns the untruncated description.' },
      },
    },
  },
  {
    name: 'get_event',
    description: 'Get details of an event by ID. Returns slim columns by default (drops image_url, created_at, updated_at, gcal_event_id, event_type, shared_with_*); pass fields:"full" for everything. Response includes memories: [{id, external_id, source, caption}] for already-attached photos — use external_ids where source="google_photos" as the skip list when scanning Google Photos.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event UUID' },
        fields: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) returns slim columns; full returns every column including image_url, gcal_event_id, timestamps.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new event or reminder in Plannen',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        start_date: { type: 'string', description: 'ISO 8601, e.g. 2026-06-15T10:00:00Z' },
        end_date: { type: 'string', description: 'ISO 8601 or omit' },
        location: { type: 'string' },
        event_kind: { type: 'string', enum: ['event', 'reminder'] },
        enrollment_url: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Tags without # (max 5)' },
        event_status: { type: 'string', enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'], description: 'Initial status (default: going for future, past for past dates)' },
        recurrence_rule: {
          type: 'object',
          description: 'For recurring programmes (e.g. weekly sessions). Generates child session events.',
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Every N periods (default 1)' },
            days: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }, description: 'Days for weekly recurrence' },
            count: { type: 'number', description: 'Number of sessions' },
            until: { type: 'string', description: 'ISO date to stop generating sessions' },
            session_duration_minutes: { type: 'number', description: 'Duration of each session in minutes' },
          },
          required: ['frequency'],
        },
      },
      required: ['title', 'start_date'],
    },
  },
  {
    name: 'update_event',
    description: 'Update fields on an existing event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event UUID' },
        title: { type: 'string' },
        description: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        location: { type: 'string' },
        event_status: { type: 'string', enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'] },
        enrollment_url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rsvp_event',
    description: 'Set your RSVP for an event',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        status: { type: 'string', enum: ['going', 'maybe', 'not_going'] },
      },
      required: ['event_id', 'status'],
    },
  },
  {
    name: 'add_event_memory',
    description: 'Attach a photo, video, or audio clip from an external source (Google Photos, Google Drive) to an event by external id only. NOTE: for Google Photos, prefer create_photo_picker_session + poll_photo_picker_session — those download the bytes and store them locally so the UI can display the media. add_event_memory only stores the id and is for advanced/manual cases. Idempotent on (event_id, external_id).',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event UUID' },
        external_id: { type: 'string', description: 'Google Photos mediaItem id (or Drive file id)' },
        source: { type: 'string', enum: ['google_photos', 'google_drive'], description: 'Provider; defaults to google_photos' },
        caption: { type: 'string', description: 'Optional caption' },
        media_type: {
          type: 'string',
          enum: ['image', 'video', 'audio'],
          description: 'Kind of media being attached. Defaults to image for backwards compat.',
        },
      },
      required: ['event_id', 'external_id'],
    },
  },
  {
    name: 'list_event_memories',
    description: 'List memories attached to an event, ordered by taken_at ASC (NULLS LAST), then created_at ASC. Returns id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at. The transcript field is populated for audio memories that have been transcribed via transcribe_memory; null otherwise. Use it for story context.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event UUID' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'transcribe_memory',
    description: 'Transcribe an audio event_memory using a host-side whisper.cpp install (the `whisper-cli` binary on PATH). Reads the audio bytes from the storage URL, spawns whisper-cli, parses the result, and persists transcript + transcript_lang on the row. Idempotent — returns the existing transcript without re-running if already populated. Returns { ok: false, error: "whisper_not_installed" } if whisper-cli is not on PATH so callers can degrade gracefully (no error popup). Image and video rows return error "unsupported_media_type". Use this from the stories skill before composing, once per audio memory.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        force:     { type: 'boolean', description: 'Re-transcribe even if a transcript already exists' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'create_story',
    description: 'Create (or overwrite, if event_ids has length 1 and a story already exists for that event AT THE SAME LANGUAGE) an AI-generated story. Pass language to write a non-English story (default "en"). Pass story_group_id to link this row as a translation of an existing story group — siblings sharing a story_group_id render as language pills in the UI. Single-event overwrite is now scoped by (event, language); generating an EN story for event X does NOT overwrite the NL one. cover_url defaults to the first IMAGE memory by taken_at across linked events.',
    inputSchema: {
      type: 'object',
      properties: {
        event_ids:      { type: 'array', items: { type: 'string' }, description: 'One or more event UUIDs' },
        title:          { type: 'string' },
        body:           { type: 'string', description: 'Markdown allowed' },
        user_notes:     { type: 'string', description: 'Optional reflection from the user' },
        mood:           { type: 'string', description: 'Optional, e.g. "chill", "memorable"' },
        tone:           { type: 'string', description: 'Optional, e.g. "diary", "postcard"' },
        cover_url:      { type: 'string', description: 'Optional override; defaults to first IMAGE memory by taken_at' },
        date_from:      { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
        date_to:        { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
        language:       { type: 'string', description: 'BCP-47 short code, e.g. "en", "nl", "fr". Default "en".' },
        story_group_id: { type: 'string', description: 'UUID; pass when creating a sibling translation of an existing story so they share a group.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'update_story',
    description: 'Update title, body, or cover_url on a story. The trigger stamps edited_at when title or body changes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Story UUID' },
        title: { type: 'string' },
        body: { type: 'string' },
        cover_url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_story',
    description: 'Fetch a single story by id, including a small array of linked event summaries (id, title, start_date) and a siblings array [{id, language}] of all translations sharing this story\'s story_group_id (including itself).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_stories',
    description: "List the current user's stories, ordered by generated_at DESC. Each row includes a small events array for subtitles.",
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Default 50' },
        offset: { type: 'number', description: 'Default 0' },
      },
    },
  },
  {
    name: 'delete_story',
    description: 'Delete a story (cascades to story_events).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_photo_picker_session',
    description: 'Create a Google Photos picker session. Returns picker_uri (open in browser to pick photos) and session_id. After the user selects photos, call poll_photo_picker_session with the session_id and the target event_id to download the bytes into Plannen and attach as memories. Single-user local-only — uses the OAuth token connected via the Plannen UI.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'poll_photo_picker_session',
    description: 'Poll a Google Photos picker session. If the user has finished picking, downloads each selected photo, uploads bytes to the event-photos storage bucket, and creates event_memories rows so the photos appear in the Plannen UI for the given event. Idempotent: re-attaching the same picker id is silently skipped. Returns { status: "pending" } if user has not finished, otherwise { status: "complete", attached: [...], skipped: [...] }.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by create_photo_picker_session' },
        event_id: { type: 'string', description: 'Plannen event UUID to attach the picked photos to' },
      },
      required: ['session_id', 'event_id'],
    },
  },
  {
    name: 'get_gcal_sync_candidates',
    description: 'Return all going events not yet synced to Google Calendar. Each item includes gcal_start/gcal_end as local datetime strings (no UTC offset) in gcal_timezone (IANA, e.g. "Europe/Brussels"). Pass both gcal_start and gcal_timezone to Google Calendar create_event so the event shows at the correct local time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_gcal_event_id',
    description: 'Store the Google Calendar event ID on a Plannen event after syncing. Pass null to clear it.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
        gcal_event_id: { type: ['string', 'null'], description: 'GCal event ID returned by create_event, or null to clear' },
      },
      required: ['event_id', 'gcal_event_id'],
    },
  },
  {
    name: 'list_relationships',
    description: 'List your family and friends in Plannen',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['family', 'friend', 'all'],
          description: 'Filter by relationship type (default all)',
        },
      },
    },
  },
  {
    name: 'get_profile_context',
    description:
      "Return the user's profile context: saved locations, interests, goals, offline family members (with IDs for use as upsert_profile_fact subjects), and all current profile_facts (confidence≥0.6). Call this at the start of every session to prime context, and when the user's query references personal context like \"my son\", \"near home\". Pass include_historical=true to also return past facts with a \"used to\" meaning.",
    inputSchema: {
      type: 'object',
      properties: {
        include_historical: { type: 'boolean', description: 'Also return historical (corrected/contradicted) facts' },
      },
    },
  },
  {
    name: 'update_profile',
    description: "Save or update the user's profile: date of birth, personal goals, interests, and timezone. Infer timezone from the user's city/country (e.g. Mechelen, Belgium → Europe/Brussels) and confirm before saving.",
    inputSchema: {
      type: 'object',
      properties: {
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD, or null to clear' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Free-text personal goals (replaces existing list)' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Free-text interest tags (replaces existing list)' },
        timezone: { type: 'string', description: 'IANA timezone, e.g. "Europe/Brussels", "Australia/Sydney", "America/New_York". Derive from city/country and confirm with user.' },
      },
      required: [],
    },
  },
  {
    name: 'get_story_languages',
    description: 'Return the user\'s configured story languages from user_profiles.story_languages. Order matters — the first entry is the canonical language used for the initial composition; subsequent entries are translations. Always returns at least one language ("en" default).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_story_languages',
    description: 'Set the user\'s configured story languages (1–3, ordered, codes from: en, nl, fr, de, es, it, pt, hi, mr, ja, zh, ar). Order is preserved; the first entry is canonical.',
    inputSchema: {
      type: 'object',
      properties: {
        languages: { type: 'array', items: { type: 'string' } },
      },
      required: ['languages'],
    },
  },
  {
    name: 'add_family_member',
    description: 'Add an offline family member (someone who does not have a Plannen account, e.g. a child).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        relation: { type: 'string', description: 'e.g. "son", "daughter", "mother", "father"' },
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD' },
        gender: { type: ['string', 'null'], description: 'e.g. "male", "female"' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Goals for this family member' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Interests/hobbies for this family member (e.g. "hockey", "swimming")' },
      },
      required: ['name', 'relation'],
    },
  },
  {
    name: 'list_family_members',
    description: 'List all offline family members with their computed ages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_location',
    description: "Add a named location (e.g. Home, Work) to the user's saved locations.",
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'e.g. "Home", "Work"' },
        address: { type: 'string', description: 'Full address string' },
        city: { type: 'string' },
        country: { type: 'string' },
        is_default: { type: 'boolean', description: 'Set as default location for searches (clears any existing default)' },
      },
      required: ['label'],
    },
  },
  {
    name: 'list_locations',
    description: "List the user's saved locations.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_event_watch_task',
    description: 'Get the watch task for a specific event (if one exists). Returns task status, last checked time, and whether there is an unread update.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_watch_queue',
    description: 'Return all watched events due for checking (next_check <= now, status = active). Call this at session start to know if any events need checking. Returns empty array if nothing is due — stay silent in that case.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_watch_task',
    description: 'Save results after checking a watched event. Call this after fetching the enrollment URL and comparing to last_result. Set has_unread_update=true and update_summary when something changed. Compute next_check based on event proximity: >6 months → +7 days, 1-6 months → +2 days, <1 month → +1 day. Set status=failed and stop if fail_count reaches 3. When confirmed dates change, update last_occurrence_date to the new confirmed start date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'agent_tasks UUID' },
        last_result: { type: 'object', description: 'Extracted details: { dates?, price?, enrollment_open?, deadline?, notes? }' },
        last_page_hash: { type: 'string', description: 'Short hash or fingerprint of page content for future diffing' },
        next_check: { type: 'string', description: 'ISO timestamp for next scheduled check' },
        fail_count: { type: 'number', description: 'Consecutive failure count (reset to 0 on success, increment on fetch error)' },
        has_unread_update: { type: 'boolean', description: 'Set true when content changed since last check' },
        update_summary: { type: 'string', description: 'Human-readable summary shown as badge (e.g. "Registration now open · €450/week")' },
        status: { type: 'string', enum: ['active', 'failed'], description: 'Set failed when fail_count reaches 3' },
        recurrence_months: { type: 'number', description: 'How often the event repeats in months (12=annual, 6=biannual, omit if unknown)' },
        last_occurrence_date: { type: 'string', description: 'ISO date of the most recent confirmed occurrence — update when new confirmed dates are found' },
      },
      required: ['task_id', 'last_result', 'last_page_hash', 'next_check', 'fail_count', 'has_unread_update'],
    },
  },
  {
    name: 'create_watch_task',
    description: 'Create (or reactivate) a recurring watch task for an event. Use when the user wants to watch an event that has no watch task yet. Upserts on event_id+task_type so it is safe to call on existing events.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
        recurrence_months: { type: 'number', description: 'How often the event repeats in months (12=annual, 6=biannual, omit if unknown)' },
        last_occurrence_date: { type: 'string', description: 'ISO date of the most recent known occurrence (e.g. "2026-01-09")' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'save_source',
    description: "Save a source (organiser, platform, or one-off page) as a standalone bookmark — without creating an event. Call this when the user explicitly asks to save/bookmark a link, says a specific link looks good (\"X looks good\", \"send X to whatsapp\"), or accepts the end-of-discovery batch ask. The agent must have the page content first (from WebFetch) so name/tags/source_type can be derived. Tags follow the same vocabulary as update_source — lead with the specific activity. Returns action: 'inserted' for a new bookmark, 'updated' when refreshing an existing one.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) source URL' },
        name: { type: 'string', description: 'Human-readable organiser/platform name' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 descriptive tags (activity first, then audience, geography, cadence, format)' },
        source_type: { type: 'string', enum: ['platform', 'organiser', 'one_off'], description: 'platform = publishes many events; organiser = single entity with recurring events; one_off = single event page' },
      },
      required: ['url', 'name', 'tags', 'source_type'],
    },
  },
  {
    name: 'update_source',
    description: "Save analysis results for an event source. Call this after fetching the source's homepage and identifying what kinds of events it publishes. Assigns up to 10 tags from activity types (camp, workshop, sailing, climbing, music, sports, hiking, yoga, theatre), audience (kids, adults, family, teens), geography (country/city names), cadence (annual, seasonal, recurring), and format (residential, daytrip, online, weekend).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'event_sources UUID' },
        name: { type: 'string', description: 'Human-readable name of the organiser or platform' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 descriptive tags' },
        source_type: { type: 'string', enum: ['platform', 'organiser', 'one_off'], description: 'platform = publishes many events (e.g. Eventbrite); organiser = single entity with recurring events; one_off = single event page' },
      },
      required: ['id', 'name', 'tags', 'source_type'],
    },
  },
  {
    name: 'get_unanalysed_sources',
    description: 'Return all event sources that have never been analysed (last_analysed_at is null). Use when the user asks to analyse their sources, then fetch each source_url and call update_source for each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_sources',
    description: 'Query the personal source library by tag overlap. Call this before doing a web search when the user asks a discovery question (e.g. "find me a sailing course"). Pick relevant tags from the question, call search_sources, fetch the returned URLs directly, then supplement with a web search.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to match against (uses array overlap — any match counts)' },
      },
      required: ['tags'],
    },
  },
  {
    name: 'list_profile_facts',
    description: 'Return all current profile facts (is_historical=false, confidence≥0.6) for the user or a family member. Call this when the user asks "what do you know about me?" or similar, then summarise in natural language grouped by subject.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID — omit for all subjects' },
      },
    },
  },
  {
    name: 'get_historical_facts',
    description: 'Return is_historical=true facts — facts that were corrected or contradicted into the past. Use when the user asks what they "used to" like or about past preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID — omit for all subjects' },
      },
    },
  },
  {
    name: 'correct_profile_fact',
    description: 'Explicitly correct a profile fact. Marks the old value as historical (is_historical=true) and inserts the corrected value at full confidence (1.0, user_stated). Call this silently when the user corrects something — surface it only if the correction is significant.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID' },
        predicate: { type: 'string', description: 'Fact category, e.g. "goes_to_school_at"' },
        old_value: { type: 'string', description: 'The value being corrected' },
        new_value: { type: 'string', description: 'The corrected value' },
      },
      required: ['subject', 'predicate', 'old_value', 'new_value'],
    },
  },
  {
    name: 'upsert_profile_fact',
    description: 'Silently save a fact about the user or a family member. Call this every time you detect a durable fact in a user message — never mention it to the user. Call once per fact: if a message contains several distinct facts, call this tool that many times (parallel is fine). Handles insert, corroboration, and contradiction internally.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID' },
        predicate: { type: 'string', description: 'Free-form fact category, e.g. "likes", "goes_to_school_at", "allergic_to", "prefers_time_of_day"' },
        value: { type: 'string', description: 'The fact value, e.g. "football", "Esdoorn school", "peanuts", "mornings"' },
        source: { type: 'string', enum: ['agent_inferred', 'user_stated'], description: 'agent_inferred for conclusions drawn by Claude; user_stated when the user said it explicitly' },
      },
      required: ['subject', 'predicate', 'value', 'source'],
    },
  },
]

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'plannen', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    let result: unknown
    switch (name) {
      case 'list_events':        result = await listEvents(args as Parameters<typeof listEvents>[0]); break
      case 'get_event':          result = await getEvent(args as Parameters<typeof getEvent>[0]); break
      case 'create_event':       result = await createEvent(args as Parameters<typeof createEvent>[0]); break
      case 'update_event':       result = await updateEvent(args as Parameters<typeof updateEvent>[0]); break
      case 'rsvp_event':              result = await rsvpEvent(args as Parameters<typeof rsvpEvent>[0]); break
      case 'add_event_memory':        result = await addEventMemory(args as Parameters<typeof addEventMemory>[0]); break
      case 'list_event_memories':     result = await listEventMemories(args as Parameters<typeof listEventMemories>[0]); break
      case 'transcribe_memory':       result = await transcribeMemory(args as Parameters<typeof transcribeMemory>[0]); break
      case 'create_story':            result = await createStory(args as Parameters<typeof createStory>[0]); break
      case 'update_story': result = await updateStory(args as Parameters<typeof updateStory>[0]); break
      case 'get_story':    result = await getStory(args as Parameters<typeof getStory>[0]);       break
      case 'list_stories': result = await listStories(args as Parameters<typeof listStories>[0]); break
      case 'delete_story': result = await deleteStory(args as Parameters<typeof deleteStory>[0]); break
      case 'create_photo_picker_session': result = await createPhotoPickerSession(); break
      case 'poll_photo_picker_session':   result = await pollPhotoPickerSession(args as Parameters<typeof pollPhotoPickerSession>[0]); break
      case 'get_gcal_sync_candidates': result = await getGcalSyncCandidates(); break
      case 'set_gcal_event_id':        result = await setGcalEventId(args as Parameters<typeof setGcalEventId>[0]); break
      case 'list_relationships':       result = await listRelationships(args as Parameters<typeof listRelationships>[0]); break
      case 'get_profile_context':  result = await getProfileContext(args as Parameters<typeof getProfileContext>[0]); break
      case 'update_profile':       result = await updateProfile(args as Parameters<typeof updateProfile>[0]); break
      case 'get_story_languages': result = await getStoryLanguagesHandler(); break
      case 'set_story_languages': result = await setStoryLanguagesHandler(args as Parameters<typeof setStoryLanguagesHandler>[0]); break
      case 'add_family_member':    result = await addFamilyMember(args as Parameters<typeof addFamilyMember>[0]); break
      case 'list_family_members':  result = await listFamilyMembers(); break
      case 'add_location':         result = await addLocation(args as Parameters<typeof addLocation>[0]); break
      case 'list_locations':       result = await listLocations(); break
      case 'get_event_watch_task': result = await getEventWatchTask(args as Parameters<typeof getEventWatchTask>[0]); break
      case 'get_watch_queue':      result = await getWatchQueue(); break
      case 'update_watch_task':    result = await updateWatchTask(args as Parameters<typeof updateWatchTask>[0]); break
      case 'create_watch_task':    result = await createWatchTask(args as Parameters<typeof createWatchTask>[0]); break
      case 'save_source':            result = await saveSource(args as Parameters<typeof saveSource>[0]); break
      case 'update_source':          result = await updateSource(args as Parameters<typeof updateSource>[0]); break
      case 'get_unanalysed_sources': result = await getUnanalysedSources(); break
      case 'search_sources':         result = await searchSources(args as Parameters<typeof searchSources>[0]); break
      case 'list_profile_facts':     result = await listProfileFacts(args as Parameters<typeof listProfileFacts>[0]); break
      case 'get_historical_facts':   result = await getHistoricalFacts(args as Parameters<typeof getHistoricalFacts>[0]); break
      case 'correct_profile_fact':   result = await correctProfileFact(args as Parameters<typeof correctProfileFact>[0]); break
      case 'upsert_profile_fact':    result = await upsertProfileFact(args as Parameters<typeof upsertProfileFact>[0]); break
      default: throw new Error(`Unknown tool: ${name}`)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(
  `[plannen-mcp] ready — user: ${USER_EMAIL}  supabase: ${SUPABASE_URL}\n`
)
