// .env load is now a side-effect of ./env.js (also imported by db.ts). ESM
// evaluates imports top-down BEFORE this module's body, so placing it first
// guarantees process.env is populated before any downstream import reads it.
import './env.js'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { PoolClient } from 'pg'
import { pool, withUserContext } from './db.js'
import { resolveUserIdByEmail } from './userResolver.js'
import {
  initialConfidence,
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
  type FactSource,
} from './profileFacts.js'
import { generateSessionDates, parseInUserTz, type RecurrenceRule } from './recurrence.js'
import { whisperAvailable, transcribeAudioBytes, extFromContentType } from './transcribe.js'
import { parseSourceUrl, normaliseTags, validateName, validateSourceType } from './sources.js'
import { weekBoundaryStart, isPracticeDueOn, remainingThisPeriod } from './practices.js'
import { expandAndSuppress, type AttendanceRow, type BlackoutWindow } from './scheduling.js'

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const USER_EMAIL = (process.env.PLANNEN_USER_EMAIL ?? '').toLowerCase()
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const PLANNEN_TIER = process.env.PLANNEN_TIER ?? '0'
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

if (!DATABASE_URL) fatal('DATABASE_URL is required (set by bootstrap.sh)')
if (!USER_EMAIL) fatal('PLANNEN_USER_EMAIL is required')

function fatal(msg: string): never {
  process.stderr.write(`[plannen-mcp] ${msg}\n`)
  process.exit(1)
}

function tier1Only(feature: string): never {
  throw new Error(
    `${feature} requires Tier 1 (Supabase Edge Functions). Run "bash scripts/bootstrap.sh --tier 1" or upgrade your install.`
  )
}

// ── User resolution ───────────────────────────────────────────────────────────

let _userId: string | null = null

async function uid(): Promise<string> {
  if (_userId) return _userId
  _userId = await resolveUserIdByEmail(USER_EMAIL)
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
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id, completed_at, assigned_to'

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
    completed_at: e.completed_at ?? null,
    assigned_to: e.assigned_to ?? null,
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
  return await withUserContext(id, async (c) => {
    const where: string[] = ['created_by = $1']
    const params: unknown[] = [id]
    if (args.status) { params.push(args.status); where.push(`event_status = $${params.length}`) }
    if (args.from_date) { params.push(args.from_date); where.push(`start_date >= $${params.length}`) }
    if (args.to_date) { params.push(args.to_date + 'T24:00:00'); where.push(`start_date < $${params.length}`) }
    params.push(args.limit ?? 10)
    const sql = `SELECT id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline
                 FROM plannen.events
                 WHERE ${where.join(' AND ')}
                 ORDER BY start_date ASC
                 LIMIT $${params.length}`
    const { rows } = await c.query(sql, params)
    const full = args.fields === 'full'
    return rows.map((e: Record<string, unknown>) => ({
      ...e,
      description: full ? e.description : truncateDescription(e.description),
      start_date: e.start_date ? toLocalIso(e.start_date as string, tz) : e.start_date,
      end_date: e.end_date ? toLocalIso(e.end_date as string, tz) : e.end_date,
      user_timezone: tz,
    }))
  })
}

async function getEvent(args: { id: string; fields?: 'summary' | 'full' }) {
  const [id, tz] = await Promise.all([uid(), getUserTimezone()])
  const selectCols = args.fields === 'full' ? '*' : SLIM_EVENT_COLUMNS
  return await withUserContext(id, async (c) => {
    const { rows: dataRows } = await c.query(
      `SELECT ${selectCols} FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [args.id, id],
    )
    if (dataRows.length === 0) throw new Error('Not found')
    const data = dataRows[0] as Record<string, unknown>

    const localise = <T extends { start_date?: string | null; end_date?: string | null }>(e: T) => ({
      ...e,
      start_date: e.start_date ? toLocalIso(e.start_date, tz) : e.start_date,
      end_date: e.end_date ? toLocalIso(e.end_date, tz) : e.end_date,
      user_timezone: tz,
    })

    const { rows: memoryRows } = await c.query(
      'SELECT id, external_id, source, caption FROM plannen.event_memories WHERE event_id = $1',
      [data.id],
    )
    const memories = memoryRows

    // Recurring parent: embed sessions
    if (data.recurrence_rule) {
      const { rows: sessions } = await c.query(
        `SELECT id, title, start_date, end_date, event_status
         FROM plannen.events
         WHERE parent_event_id = $1
         ORDER BY start_date ASC`,
        [data.id],
      )
      return { ...localise(data as { start_date?: string | null; end_date?: string | null }), sessions: sessions.map(localise), memories }
    }

    // Session: embed parent summary
    if (data.parent_event_id) {
      const { rows: parentRows } = await c.query(
        'SELECT id, title, start_date, recurrence_rule FROM plannen.events WHERE id = $1',
        [data.parent_event_id],
      )
      if (parentRows.length === 0) throw new Error('Not found')
      const parent = parentRows[0]
      return { ...localise(data as { start_date?: string | null; end_date?: string | null }), parent: localise(parent), memories }
    }

    return { ...data, memories }
  })
}

const VALID_EVENT_STATUSES = ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'] as const
type EventStatus = typeof VALID_EVENT_STATUSES[number]

async function upsertSource(
  c: PoolClient,
  userId: string,
  eventId: string | null,
  enrollmentUrl: string
): Promise<{ id: string; last_analysed_at: string | null } | null> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return null
  const { rows: srcRows } = await c.query(
    `INSERT INTO plannen.event_sources (user_id, domain, source_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, domain) DO UPDATE
       SET source_url = EXCLUDED.source_url
     RETURNING id, last_analysed_at`,
    [userId, domain, enrollmentUrl],
  )
  if (srcRows.length === 0) return null
  const src = srcRows[0] as { id: string; last_analysed_at: string | null }
  if (eventId !== null) {
    await c.query(
      `INSERT INTO plannen.event_source_refs (event_id, source_id, user_id, ref_type)
       VALUES ($1, $2, $3, 'enrollment_url')
       ON CONFLICT (event_id, source_id) DO NOTHING`,
      [eventId, src.id, userId],
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
  assigned_to?: string
}) {
  const id = await uid()
  const tz = await getUserTimezone()
  // Naive timestamps mean wall-clock time in the user's tz — never the server tz.
  const startDate = parseInUserTz(args.start_date, tz)
  const endDate = args.end_date ? parseInUserTz(args.end_date, tz) : null
  const event_status: EventStatus =
    args.event_status && VALID_EVENT_STATUSES.includes(args.event_status as EventStatus)
      ? (args.event_status as EventStatus)
      : startDate < new Date() ? 'past' : 'going'

  return await withUserContext(id, async (c) => {
    const hashtags = (args.hashtags ?? []).slice(0, 5)
    const { rows } = await c.query(
      `INSERT INTO plannen.events
         (title, description, start_date, end_date, location, event_kind,
          enrollment_url, hashtags, event_type, event_status, created_by,
          assigned_to, shared_with_friends, recurrence_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, 'none', $12)
       RETURNING *`,
      [
        args.title,
        args.description ?? null,
        startDate.toISOString(),
        endDate ? endDate.toISOString() : null,
        args.location ?? null,
        args.event_kind === 'reminder' || args.event_kind === 'todo' ? args.event_kind : 'event',
        args.enrollment_url ?? null,
        hashtags,
        event_status,
        id,
        args.event_kind === 'todo' ? (args.assigned_to ?? id) : null,
        args.recurrence_rule ?? null,
      ],
    )
    if (rows.length === 0) throw new Error('Insert failed')
    const data = rows[0] as Record<string, unknown> & { id: string }

    if (args.recurrence_rule) {
      const dates = generateSessionDates(startDate.toISOString(), args.recurrence_rule, tz)
      for (let i = 0; i < dates.length; i++) {
        const d = dates[i]
        await c.query(
          `INSERT INTO plannen.events
             (title, description, start_date, end_date, location, event_kind,
              event_type, event_status, created_by, parent_event_id,
              shared_with_friends, hashtags)
           VALUES ($1, $2, $3, $4, $5, 'session', 'personal', $6, $7, $8, 'none', $9)`,
          [
            `${args.title} – Session ${i + 1}`,
            args.description ?? null,
            d.start.toISOString(),
            d.end ? d.end.toISOString() : null,
            args.location ?? null,
            event_status,
            id,
            data.id,
            hashtags,
          ],
        )
      }
    }

    const source = args.enrollment_url
      ? await upsertSource(c, id, data.id, args.enrollment_url)
      : null

    return { ...slimEvent(data), source }
  })
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
  // Naive timestamps mean wall-clock time in the user's tz — never the server tz.
  if (rest.start_date || rest.end_date) {
    const tz = await getUserTimezone()
    if (rest.start_date) rest.start_date = parseInUserTz(rest.start_date, tz).toISOString()
    if (rest.end_date) rest.end_date = parseInUserTz(rest.end_date, tz).toISOString()
  }
  const entries = Object.entries(rest).filter(([, v]) => v !== undefined)
  return await withUserContext(id, async (c) => {
    const setClauses: string[] = []
    const params: unknown[] = []
    for (const [k, v] of entries) {
      params.push(v)
      setClauses.push(`${k} = $${params.length}`)
    }
    params.push(new Date().toISOString())
    setClauses.push(`updated_at = $${params.length}`)
    params.push(args.id)
    params.push(id)
    const sql = `UPDATE plannen.events SET ${setClauses.join(', ')}
                 WHERE id = $${params.length - 1} AND created_by = $${params.length}
                 RETURNING *`
    const { rows } = await c.query(sql, params)
    if (rows.length === 0) throw new Error('Not found')
    const data = rows[0] as Record<string, unknown> & { enrollment_url?: string | null }
    const source = data.enrollment_url
      ? await upsertSource(c, id, args.id, data.enrollment_url)
      : null
    return { ...slimEvent(data), source }
  })
}

async function completeTodo(args: { id: string; completed_at?: string }) {
  const uId = await uid()
  const ts = args.completed_at ?? new Date().toISOString()
  return await withUserContext(uId, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.events SET completed_at = $1, updated_at = now()
       WHERE id = $2 AND created_by = $3 AND event_kind = 'todo'
       RETURNING *`,
      [ts, args.id, uId],
    )
    if (rows.length === 0) throw new Error('todo not found')
    return slimEvent(rows[0] as Record<string, unknown>)
  })
}

async function uncompleteTodo(args: { id: string }) {
  const uId = await uid()
  return await withUserContext(uId, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.events SET completed_at = NULL, updated_at = now()
       WHERE id = $1 AND created_by = $2 AND event_kind = 'todo'
       RETURNING *`,
      [args.id, uId],
    )
    if (rows.length === 0) throw new Error('todo not found')
    return slimEvent(rows[0] as Record<string, unknown>)
  })
}

async function rsvpEvent(args: { event_id: string; status: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    await c.query(
      `INSERT INTO plannen.event_rsvps (event_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
      [args.event_id, id, args.status],
    )
    return { success: true, event_id: args.event_id, status: args.status }
  })
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
  return await withUserContext(id, async (c) => {
    // ignoreDuplicates semantics: only insert if (event_id, external_id) is new.
    const { rows } = await c.query(
      `INSERT INTO plannen.event_memories
         (event_id, user_id, media_url, media_type, source, external_id, caption)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)
       ON CONFLICT (event_id, external_id) DO NOTHING
       RETURNING id`,
      [args.event_id, id, mediaType, source, args.external_id, args.caption ?? null],
    )
    const inserted = rows[0] as { id: string } | undefined
    return {
      attached: !!inserted,
      id: inserted?.id ?? null,
      event_id: args.event_id,
      external_id: args.external_id,
    }
  })
}

async function listEventMemories(args: { event_id?: string; event_ids?: string[] }) {
  const userId = await uid()
  const ids = args.event_ids && args.event_ids.length > 0
    ? args.event_ids
    : (args.event_id ? [args.event_id] : [])
  if (ids.length === 0) throw new Error('event_id or event_ids is required')
  return await withUserContext(userId, async (c) => {
    const { rows: evtRows } = await c.query(
      'SELECT id, created_by FROM plannen.events WHERE id = ANY($1::uuid[])',
      [ids],
    )
    if (evtRows.length !== ids.length) throw new Error('Event not found')
    for (const r of evtRows as { created_by: string }[]) {
      if (r.created_by !== userId) throw new Error('Event not found')
    }
    const { rows } = await c.query(
      `SELECT id, event_id, media_url, media_type, caption, taken_at, created_at,
              external_id, source, transcript, transcript_lang, transcribed_at
       FROM plannen.event_memories
       WHERE event_id = ANY($1::uuid[])
       ORDER BY event_id ASC, taken_at ASC NULLS LAST, created_at ASC`,
      [ids],
    )
    return rows
  })
}

async function listEventNotes(args: { event_id?: string; event_ids?: string[] }) {
  const userId = await uid()
  const ids = args.event_ids && args.event_ids.length > 0
    ? args.event_ids
    : (args.event_id ? [args.event_id] : [])
  if (ids.length === 0) throw new Error('event_id or event_ids is required')
  return await withUserContext(userId, async (c) => {
    const { rows: evtRows } = await c.query(
      'SELECT id, created_by FROM plannen.events WHERE id = ANY($1::uuid[])',
      [ids],
    )
    if (evtRows.length !== ids.length) throw new Error('Event not found')
    for (const r of evtRows as { created_by: string }[]) {
      if (r.created_by !== userId) throw new Error('Event not found')
    }
    const { rows } = await c.query(
      `SELECT n.id, n.event_id, n.user_id, n.body, n.created_at, n.updated_at,
              u.full_name AS author_full_name, u.email AS author_email
         FROM plannen.event_notes n
         JOIN plannen.users u ON u.id = n.user_id
        WHERE n.event_id = ANY($1::uuid[])
        ORDER BY n.event_id ASC, n.created_at ASC`,
      [ids],
    )
    return rows
  })
}

async function transcribeMemory(args: { memory_id: string; force?: boolean }) {
  const userId = await uid()
  // Phase 1: read the row + check cache inside one tx; do whisper outside;
  // update in a second tx. Splitting keeps the network/whisper work out of the
  // DB transaction so the connection isn't held while audio is processed.
  const row = await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, media_type, media_url, transcript, transcript_lang
       FROM plannen.event_memories WHERE id = $1`,
      [args.memory_id],
    )
    return rows[0] as
      | { id: string; media_type: string; media_url: string | null; transcript: string | null; transcript_lang: string | null }
      | undefined
  })
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

  await withUserContext(userId, async (c) => {
    await c.query(
      `UPDATE plannen.event_memories
       SET transcript = $1, transcript_lang = $2, transcribed_at = $3
       WHERE id = $4`,
      [transcript, language, new Date().toISOString(), args.memory_id],
    )
  })

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

  return await withUserContext(userId, async (c) => {
    if (eventIds.length) {
      const { rows: events } = await c.query(
        'SELECT id, created_by FROM plannen.events WHERE id = ANY($1)',
        [eventIds],
      )
      const ownedIds = new Set(
        events.filter((e: { created_by: string }) => e.created_by === userId).map((e: { id: string }) => e.id)
      )
      const missing = eventIds.filter(id => !ownedIds.has(id))
      if (missing.length) throw new Error(`Events not found or not owned: ${missing.join(', ')}`)
    }

    if (eventIds.length === 1) {
      const lang = args.language ?? 'en'
      const { rows: existingRows } = await c.query(
        `SELECT se.story_id
         FROM plannen.story_events se
         JOIN plannen.stories s ON s.id = se.story_id
         WHERE se.event_id = $1 AND s.user_id = $2 AND s.language = $3
         LIMIT 1`,
        [eventIds[0], userId, lang],
      )
      const existing = existingRows[0] as { story_id: string } | undefined
      if (existing?.story_id) {
        const setClauses = [
          'title = $1', 'body = $2', 'user_notes = $3', 'mood = $4', 'tone = $5', 'generated_at = $6',
        ]
        const params: unknown[] = [
          args.title,
          args.body,
          args.user_notes ?? null,
          args.mood ?? null,
          args.tone ?? null,
          new Date().toISOString(),
        ]
        if (args.cover_url !== undefined) { params.push(args.cover_url); setClauses.push(`cover_url = $${params.length}`) }
        if (args.story_group_id) { params.push(args.story_group_id); setClauses.push(`story_group_id = $${params.length}`) }
        params.push(existing.story_id)
        const { rows } = await c.query(
          `UPDATE plannen.stories SET ${setClauses.join(', ')}
           WHERE id = $${params.length}
           RETURNING id, story_group_id, language`,
          params,
        )
        if (rows.length === 0) throw new Error('Story update failed')
        const data = rows[0] as { id: string; story_group_id: string; language: string }
        return { id: data.id, story_group_id: data.story_group_id, language: data.language, overwritten: true }
      }
    }

    let coverUrl: string | null = args.cover_url ?? null
    if (!coverUrl && eventIds.length) {
      const { rows: mem } = await c.query(
        `SELECT media_url FROM plannen.event_memories
         WHERE event_id = ANY($1) AND media_url IS NOT NULL AND media_type = 'image'
         ORDER BY taken_at ASC NULLS LAST, created_at ASC
         LIMIT 1`,
        [eventIds],
      )
      coverUrl = (mem[0]?.media_url as string | undefined) ?? null
    }

    const insertCols = ['user_id', 'title', 'body', 'cover_url', 'user_notes', 'mood', 'tone', 'date_from', 'date_to', 'language']
    const insertVals: unknown[] = [
      userId, args.title, args.body, coverUrl,
      args.user_notes ?? null, args.mood ?? null, args.tone ?? null,
      args.date_from ?? null, args.date_to ?? null, args.language ?? 'en',
    ]
    if (args.story_group_id) { insertCols.push('story_group_id'); insertVals.push(args.story_group_id) }
    const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ')
    const { rows: storyRows } = await c.query(
      `INSERT INTO plannen.stories (${insertCols.join(', ')})
       VALUES (${placeholders})
       RETURNING id, story_group_id, language`,
      insertVals,
    )
    if (storyRows.length === 0) throw new Error('Story insert failed')
    const story = storyRows[0] as { id: string; story_group_id: string; language: string }

    if (eventIds.length) {
      for (const event_id of eventIds) {
        await c.query(
          'INSERT INTO plannen.story_events (story_id, event_id) VALUES ($1, $2)',
          [story.id, event_id],
        )
      }
    }

    return { id: story.id, story_group_id: story.story_group_id, language: story.language, overwritten: false }
  })
}

async function updateStory(args: {
  id: string
  title?: string
  body?: string
  cover_url?: string
}) {
  const userId = await uid()
  const setClauses: string[] = []
  const params: unknown[] = []
  if (args.title !== undefined) { params.push(args.title); setClauses.push(`title = $${params.length}`) }
  if (args.body !== undefined) { params.push(args.body); setClauses.push(`body = $${params.length}`) }
  if (args.cover_url !== undefined) { params.push(args.cover_url); setClauses.push(`cover_url = $${params.length}`) }
  if (setClauses.length === 0) throw new Error('No fields to update')
  return await withUserContext(userId, async (c) => {
    params.push(args.id)
    params.push(userId)
    const { rows } = await c.query(
      `UPDATE plannen.stories SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new Error('Not found')
    const story = rows[0] as Record<string, unknown> & { id: string }
    const { rows: linkRows } = await c.query(
      `SELECT e.id, e.title, e.start_date
       FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
       WHERE se.story_id = $1`,
      [story.id],
    )
    return { ...story, events: linkRows }
  })
}

async function getStory(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows: storyRows } = await c.query(
      'SELECT * FROM plannen.stories WHERE id = $1 AND user_id = $2',
      [args.id, userId],
    )
    if (storyRows.length === 0) return null
    const story = storyRows[0] as Record<string, unknown> & { id: string; story_group_id: string }
    const { rows: eventRows } = await c.query(
      `SELECT e.id, e.title, e.start_date
       FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
       WHERE se.story_id = $1`,
      [story.id],
    )
    const { rows: siblings } = await c.query(
      `SELECT id, language FROM plannen.stories
       WHERE story_group_id = $1 ORDER BY generated_at ASC`,
      [story.story_group_id],
    )
    return { ...story, events: eventRows, siblings }
  })
}

async function listStories(args: { limit?: number; offset?: number; story_group_id?: string } = {}) {
  const userId = await uid()
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  return await withUserContext(userId, async (c) => {
    const params: unknown[] = [userId, offset, limit]
    let groupClause = ''
    if (args.story_group_id) {
      params.push(args.story_group_id)
      groupClause = ` AND story_group_id = $${params.length}`
    }
    const { rows: storyRows } = await c.query(
      `SELECT * FROM plannen.stories WHERE user_id = $1${groupClause}
       ORDER BY generated_at DESC
       OFFSET $2 LIMIT $3`,
      params,
    )
    if (storyRows.length === 0) return []
    const ids = storyRows.map((r: { id: string }) => r.id)
    const { rows: linkRows } = await c.query(
      `SELECT se.story_id, e.id, e.title, e.start_date
       FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
       WHERE se.story_id = ANY($1)`,
      [ids],
    )
    const byStory = new Map<string, Array<{ id: string; title: string | null; start_date: string | null }>>()
    for (const r of linkRows as Array<{ story_id: string; id: string; title: string | null; start_date: string | null }>) {
      const arr = byStory.get(r.story_id) ?? []
      arr.push({ id: r.id, title: r.title, start_date: r.start_date })
      byStory.set(r.story_id, arr)
    }
    return storyRows.map((row: Record<string, unknown> & { id: string }) => ({
      ...row,
      events: byStory.get(row.id) ?? [],
    }))
  })
}

async function deleteStory(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rowCount } = await c.query(
      'DELETE FROM plannen.stories WHERE id = $1 AND user_id = $2',
      [args.id, userId],
    )
    if (!rowCount) throw new Error('Not found')
    return { success: true }
  })
}

async function getGoogleAccessToken(): Promise<string> {
  const userId = await uid()
  const row = await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT access_token, expires_at, refresh_token
       FROM plannen.user_oauth_tokens
       WHERE user_id = $1 AND provider = 'google'`,
      [userId],
    )
    return rows[0] as
      | { access_token: string | null; expires_at: string | null; refresh_token: string }
      | undefined
  })
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
  await withUserContext(userId, async (c) => {
    await c.query(
      `UPDATE plannen.user_oauth_tokens
       SET access_token = $1, expires_at = $2, updated_at = $3
       WHERE user_id = $4 AND provider = 'google'`,
      [
        tokens.access_token,
        new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
        new Date().toISOString(),
        userId,
      ],
    )
  })
  return tokens.access_token
}

async function createPhotoPickerSession() {
  if (PLANNEN_TIER === '0') tier1Only('Photo picker')
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
  if (PLANNEN_TIER === '0') tier1Only('Photo picker')
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

  return await withUserContext(userId, async (c) => {
    for (const item of items) {
      if (!item.id || !item.mediaFile?.baseUrl) {
        skipped.push({ external_id: item.id ?? '', reason: 'missing id or baseUrl' })
        continue
      }
      if (item.type && item.type !== 'PHOTO') {
        skipped.push({ external_id: item.id, reason: `unsupported type ${item.type}` })
        continue
      }

      const { rows: existingRows } = await c.query(
        'SELECT id FROM plannen.event_memories WHERE event_id = $1 AND external_id = $2',
        [args.event_id, item.id],
      )
      const existing = existingRows[0] as { id: string } | undefined
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
      // bytes are intentionally discarded on Tier 0; this branch is unreachable
      // because of the tier1Only guard above. The shape matches Tier 1.
      const mimeType = item.mediaFile.mimeType ?? bytesRes.headers.get('Content-Type') ?? 'image/jpeg'
      const ext = PICKER_MIME_TO_EXT[mimeType.toLowerCase()] ?? 'jpg'
      const path = `${args.event_id}/${userId}/${item.id}.${ext}`
      // Tier 1 path: bytes would be uploaded to Supabase storage here; URL shape
      // must match what the column stored when Supabase storage was used.
      const publicUrl = `/storage/v1/object/public/event-photos/${path}`

      const { rows: insertedRows } = await c.query(
        `INSERT INTO plannen.event_memories
           (event_id, user_id, source, external_id, media_url, media_type, taken_at)
         VALUES ($1, $2, 'google_photos', $3, $4, 'image', $5)
         RETURNING id`,
        [args.event_id, userId, item.id, publicUrl, item.createTime ?? null],
      )
      const inserted = insertedRows[0] as { id: string } | undefined
      if (!inserted) {
        skipped.push({ external_id: item.id, reason: 'insert failed: unknown' })
        continue
      }
      attached.push({ external_id: item.id, memory_id: inserted.id, filename: item.mediaFile.filename })
    }

    return { status: 'complete' as const, attached, skipped, total_selected: items.length }
  })
}

async function getUserTimezone(): Promise<string> {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      'SELECT timezone FROM plannen.user_profiles WHERE user_id = $1 LIMIT 1',
      [id],
    )
    return (rows[0]?.timezone as string | undefined) ?? 'UTC'
  })
}

async function getGcalSyncCandidates() {
  const [id, tz] = await Promise.all([uid(), getUserTimezone()])
  return await withUserContext(id, async (c) => {
    const { rows: events } = await c.query(
      `SELECT id, title, description, start_date, end_date, location, event_kind, hashtags, enrollment_url
       FROM plannen.events
       WHERE created_by = $1 AND event_status = 'going'
         AND gcal_event_id IS NULL AND recurrence_rule IS NULL
       ORDER BY start_date ASC`,
      [id],
    )
    if (events.length === 0) return []
    const ids = events.map((e: { id: string }) => e.id)
    const { rows: rsvps } = await c.query(
      `SELECT event_id, preferred_visit_date FROM plannen.event_rsvps
       WHERE user_id = $1 AND event_id = ANY($2)`,
      [id, ids],
    )
    const visitMap = new Map<string, string | null>()
    for (const r of rsvps as Array<{ event_id: string; preferred_visit_date: string | null }>) {
      visitMap.set(r.event_id, r.preferred_visit_date)
    }
    return events.map((e: { id: string; title: string; description: string | null; location: string | null; enrollment_url: string | null; event_kind: string; start_date: string; end_date: string | null }) => {
      const preferredDateRaw = visitMap.get(e.id) ?? null
      const preferredDate: string | null = preferredDateRaw
        ? (typeof preferredDateRaw === 'string'
          ? preferredDateRaw.slice(0, 10)
          : new Date(preferredDateRaw).toISOString().slice(0, 10))
        : null
      const startStr = typeof e.start_date === 'string' ? e.start_date : new Date(e.start_date).toISOString()
      const endStr = e.end_date
        ? (typeof e.end_date === 'string' ? e.end_date : new Date(e.end_date).toISOString())
        : null
      const isMultiDay = !!endStr && startStr.slice(0, 10) !== endStr.slice(0, 10)
      const useVisitDate = preferredDate && isMultiDay

      const gcal_start = useVisitDate
        ? `${preferredDate}T00:00:00`
        : toLocalIso(startStr, tz)
      const gcal_end = useVisitDate
        ? `${preferredDate}T23:59:59`
        : (endStr ? toLocalIso(endStr, tz) : null)

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
  })
}

async function setGcalEventId(args: { event_id: string; gcal_event_id: string | null }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    await c.query(
      `UPDATE plannen.events SET gcal_event_id = $1
       WHERE id = $2 AND created_by = $3`,
      [args.gcal_event_id, args.event_id, id],
    )
    return { success: true, event_id: args.event_id, gcal_event_id: args.gcal_event_id }
  })
}

async function listRelationships(_args: { type?: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: rels } = await c.query(
      `SELECT user_id, related_user_id
       FROM plannen.relationships
       WHERE (user_id = $1 OR related_user_id = $1)
         AND status = 'accepted'`,
      [id],
    )
    const relList = rels as Array<{ user_id: string; related_user_id: string }>
    const otherIds = relList.map((r) => r.user_id === id ? r.related_user_id : r.user_id)
    if (!otherIds.length) return []
    const { rows: users } = await c.query(
      'SELECT id, full_name, email FROM plannen.users WHERE id = ANY($1)',
      [otherIds],
    )
    const userList = users as Array<{ id: string; full_name: string | null; email: string | null }>
    return relList.map((r) => {
      const otherId = r.user_id === id ? r.related_user_id : r.user_id
      const person = userList.find((u) => u.id === otherId)
      return {
        id: otherId,
        full_name: person?.full_name ?? null,
        email: person?.email ?? null,
      }
    })
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
  return await withUserContext(id, async (c) => {
    const [profileRes, locationsRes, familyRes, factsRes, historicalRes, primaryCircleUsersRes] = await Promise.all([
      c.query('SELECT dob, goals, interests, timezone, primary_circle_group_ids FROM plannen.user_profiles WHERE user_id = $1', [id]),
      c.query('SELECT label, city, country, is_default FROM plannen.user_locations WHERE user_id = $1 ORDER BY created_at ASC', [id]),
      c.query('SELECT id, name, relation, dob, gender, goals, interests FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC', [id]),
      c.query(
        `SELECT subject, predicate, value, confidence, source
         FROM plannen.profile_facts
         WHERE user_id = $1 AND is_historical = false AND confidence >= 0.6
         ORDER BY subject ASC, predicate ASC`,
        [id],
      ),
      args.include_historical
        ? c.query(
          `SELECT subject, predicate, value, confidence
           FROM plannen.profile_facts
           WHERE user_id = $1 AND is_historical = true
           ORDER BY subject ASC, last_seen_at DESC`,
          [id],
        )
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      c.query(
        `SELECT DISTINCT u.id, u.full_name, u.email
           FROM plannen.user_profiles up
           JOIN plannen.friend_group_members fgm
             ON fgm.group_id = ANY(up.primary_circle_group_ids)
           JOIN plannen.users u ON u.id = fgm.user_id
          WHERE up.user_id = $1
            AND u.id <> $1`,
        [id],
      ),
    ])
    const profile = profileRes.rows[0] as { dob: string | null; goals: string[]; interests: string[]; timezone: string } | undefined
    type FamilyRow = { id: string; name: string; relation: string; dob: string | null; gender: string | null; goals: string[]; interests: string[] }
    type LocationRow = { label: string; city: string; country: string; is_default: boolean }
    return {
      goals: profile?.goals ?? [],
      interests: profile?.interests ?? [],
      timezone: profile?.timezone ?? 'UTC',
      locations: (locationsRes.rows as LocationRow[]).map((l) => ({
        label: l.label,
        city: l.city,
        country: l.country,
        is_default: l.is_default,
      })),
      family_members: (familyRes.rows as FamilyRow[]).map((m) => ({
        id: m.id,
        name: m.name,
        relation: m.relation,
        age: computeAge(m.dob),
        gender: m.gender,
        goals: m.goals,
        interests: m.interests,
      })),
      primary_circle_users: primaryCircleUsersRes.rows,
      profile_facts: factsRes.rows,
      historical_facts: args.include_historical ? historicalRes.rows : undefined,
    }
  })
}

async function updateProfile(args: { dob?: string | null; goals?: string[]; interests?: string[]; timezone?: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const cols: string[] = ['user_id']
    const vals: unknown[] = [id]
    const sets: string[] = []
    if (args.dob !== undefined) {
      cols.push('dob'); vals.push(args.dob); sets.push(`dob = $${vals.length}`)
    }
    if (args.goals !== undefined) {
      cols.push('goals'); vals.push(args.goals); sets.push(`goals = $${vals.length}`)
    }
    if (args.interests !== undefined) {
      cols.push('interests'); vals.push(args.interests); sets.push(`interests = $${vals.length}`)
    }
    if (args.timezone !== undefined) {
      cols.push('timezone'); vals.push(args.timezone); sets.push(`timezone = $${vals.length}`)
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
    const updateClause = sets.length > 0
      ? `DO UPDATE SET ${sets.join(', ')}`
      : 'DO NOTHING'
    await c.query(
      `INSERT INTO plannen.user_profiles (${cols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (user_id) ${updateClause}`,
      vals,
    )
    return { success: true }
  })
}

async function getStoryLanguagesHandler() {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      'SELECT story_languages FROM plannen.user_profiles WHERE user_id = $1',
      [id],
    )
    const langs = (rows[0]?.story_languages as string[] | null | undefined) ?? ['en']
    return { languages: langs.length ? langs : ['en'] }
  })
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
  return await withUserContext(id, async (c) => {
    await c.query(
      `INSERT INTO plannen.user_profiles (user_id, story_languages)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET story_languages = EXCLUDED.story_languages`,
      [id, cleaned],
    )
    return { languages: cleaned }
  })
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
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.family_members
         (user_id, name, relation, dob, gender, goals, interests)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        args.name,
        args.relation,
        args.dob ?? null,
        args.gender ?? null,
        args.goals ?? [],
        args.interests ?? [],
      ],
    )
    if (rows.length === 0) throw new Error('Insert failed')
    return rows[0]
  })
}

async function listFamilyMembers() {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `SELECT id, name, relation, dob, gender, goals, interests
       FROM plannen.family_members
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [id],
    )
    return (rows as Array<{ id: string; name: string; relation: string; dob: string | null; gender: string | null; goals: string[]; interests: string[] }>)
      .map((m) => ({ ...m, age: computeAge(m.dob) }))
  })
}

async function addLocation(args: {
  label: string
  address?: string
  city?: string
  country?: string
  is_default?: boolean
}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    if (args.is_default) {
      await c.query(
        'UPDATE plannen.user_locations SET is_default = false WHERE user_id = $1',
        [id],
      )
    }
    const { rows } = await c.query(
      `INSERT INTO plannen.user_locations (user_id, label, address, city, country, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        args.label,
        args.address ?? '',
        args.city ?? '',
        args.country ?? '',
        args.is_default ?? false,
      ],
    )
    if (rows.length === 0) throw new Error('Insert failed')
    return rows[0]
  })
}

async function listLocations() {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `SELECT id, label, address, city, country, is_default
       FROM plannen.user_locations
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [id],
    )
    return rows
  })
}

// ── Watch monitoring tools ────────────────────────────────────────────────────

async function getEventWatchTask(args: { event_id: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `SELECT id, event_id, task_type, status, next_check, last_checked_at,
              last_result, fail_count, has_unread_update, update_summary,
              recurrence_months, last_occurrence_date
       FROM plannen.agent_tasks
       WHERE event_id = $1 AND task_type = ANY(ARRAY['recurring_check','enrollment_monitor'])
       ORDER BY created_at DESC
       LIMIT 1`,
      [args.event_id],
    )
    const data = rows[0] as { event_id: string } | undefined
    if (!data) return null
    // Verify the event belongs to this user
    const { rows: evRows } = await c.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [data.event_id, id],
    )
    if (evRows.length === 0) return null
    return data
  })
}

async function getWatchQueue() {
  const id = await uid()
  const now = new Date().toISOString()
  return await withUserContext(id, async (c) => {
    const { rows: userEvents } = await c.query(
      `SELECT id, title, enrollment_url, start_date
       FROM plannen.events WHERE created_by = $1`,
      [id],
    )
    const eventIds = (userEvents as Array<{ id: string }>).map((e) => e.id)
    if (!eventIds.length) return []
    const { rows: tasks } = await c.query(
      `SELECT id, event_id, task_type, last_result, last_page_hash, last_checked_at,
              recurrence_months, last_occurrence_date
       FROM plannen.agent_tasks
       WHERE task_type = ANY(ARRAY['recurring_check','enrollment_monitor'])
         AND status = 'active'
         AND next_check <= $1
         AND event_id = ANY($2)`,
      [now, eventIds],
    )
    type EventLite = { id: string; title: string; enrollment_url: string | null; start_date: string }
    const eventMap = new Map<string, EventLite>(
      (userEvents as EventLite[]).map((e) => [e.id, e]),
    )
    return (tasks as Array<{
      id: string; event_id: string; task_type: string;
      last_result: unknown; last_page_hash: string | null; last_checked_at: string | null;
      recurrence_months: number | null; last_occurrence_date: string | null
    }>).map((task) => {
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
  return await withUserContext(id, async (c) => {
    const { rows: ownership } = await c.query(
      'SELECT event_id FROM plannen.agent_tasks WHERE id = $1',
      [args.task_id],
    )
    const owner = ownership[0] as { event_id: string } | undefined
    if (!owner) throw new Error('Watch task not found')
    const { rows: ownedEvent } = await c.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [owner.event_id, id],
    )
    if (ownedEvent.length === 0) throw new Error('Not authorised to update this watch task')

    const setClauses: string[] = []
    const params: unknown[] = []
    const push = (col: string, val: unknown) => { params.push(val); setClauses.push(`${col} = $${params.length}`) }
    push('last_result', args.last_result)
    push('last_page_hash', args.last_page_hash)
    push('last_checked_at', new Date().toISOString())
    push('next_check', args.next_check)
    push('fail_count', args.fail_count)
    push('has_unread_update', args.has_unread_update)
    push('updated_at', new Date().toISOString())
    if (args.update_summary !== undefined) push('update_summary', args.update_summary)
    if (args.status !== undefined) push('status', args.status)
    if (args.recurrence_months !== undefined) push('recurrence_months', args.recurrence_months)
    if (args.last_occurrence_date !== undefined) push('last_occurrence_date', args.last_occurrence_date)
    params.push(args.task_id)
    await c.query(
      `UPDATE plannen.agent_tasks SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params,
    )
    return { success: true }
  })
}

async function createWatchTask(args: {
  event_id: string
  recurrence_months?: number
  last_occurrence_date?: string
}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: evRows } = await c.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [args.event_id, id],
    )
    if (evRows.length === 0) throw new Error('Event not found or not authorised')

    const cols = ['event_id', 'task_type', 'status', 'next_check']
    const vals: unknown[] = [args.event_id, 'recurring_check', 'active', new Date().toISOString()]
    const updateSets: string[] = ['status = EXCLUDED.status', 'next_check = EXCLUDED.next_check']
    if (args.recurrence_months !== undefined) {
      cols.push('recurrence_months'); vals.push(args.recurrence_months)
      updateSets.push('recurrence_months = EXCLUDED.recurrence_months')
    }
    if (args.last_occurrence_date !== undefined) {
      cols.push('last_occurrence_date'); vals.push(args.last_occurrence_date)
      updateSets.push('last_occurrence_date = EXCLUDED.last_occurrence_date')
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
    const { rows } = await c.query(
      `INSERT INTO plannen.agent_tasks (${cols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (event_id, task_type) DO UPDATE
         SET ${updateSets.join(', ')}
       RETURNING id`,
      vals,
    )
    return { success: true, task_id: (rows[0] as { id: string } | undefined)?.id }
  })
}

// ── Source intelligence tools ─────────────────────────────────────────────────

async function updateSource(args: {
  id: string
  name: string
  tags: string[]
  source_type: 'platform' | 'organiser' | 'one_off'
}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: src } = await c.query(
      'SELECT id FROM plannen.event_sources WHERE id = $1 AND user_id = $2',
      [args.id, id],
    )
    if (src.length === 0) throw new Error('Source not found')
    await c.query(
      `UPDATE plannen.event_sources
       SET name = $1, tags = $2, source_type = $3,
           last_analysed_at = $4, updated_at = $5
       WHERE id = $6`,
      [
        args.name,
        args.tags.slice(0, 10),
        args.source_type,
        new Date().toISOString(),
        new Date().toISOString(),
        args.id,
      ],
    )
    return { success: true }
  })
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
  return await withUserContext(userId, async (c) => {
    // Detect whether the row pre-existed so we can label the action.
    const { rows: existingRows } = await c.query(
      'SELECT id FROM plannen.event_sources WHERE user_id = $1 AND domain = $2',
      [userId, domain],
    )
    const action: 'inserted' | 'updated' = existingRows.length > 0 ? 'updated' : 'inserted'

    const upserted = await upsertSource(c, userId, null, sourceUrl)
    if (!upserted) throw new Error('failed to upsert source')

    await c.query(
      `UPDATE plannen.event_sources
       SET name = $1, tags = $2, source_type = $3,
           last_analysed_at = $4, updated_at = $5
       WHERE id = $6 AND user_id = $7`,
      [
        name,
        tags,
        source_type,
        new Date().toISOString(),
        new Date().toISOString(),
        upserted.id,
        userId,
      ],
    )
    return { id: upserted.id, domain, action }
  })
}

async function getUnanalysedSources() {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `SELECT id, domain, source_url FROM plannen.event_sources
       WHERE user_id = $1 AND last_analysed_at IS NULL
       ORDER BY created_at ASC`,
      [id],
    )
    return rows
  })
}

async function searchSources(args: { tags: string[] }) {
  const id = await uid()
  if (!args.tags.length) return []
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `SELECT id, domain, source_url, name, tags, source_type
       FROM plannen.event_sources
       WHERE user_id = $1 AND tags && $2 AND last_analysed_at IS NOT NULL`,
      [id, args.tags],
    )
    return rows
  })
}

// ── Profile facts tools ───────────────────────────────────────────────────────

async function upsertProfileFact(args: {
  subject: string
  predicate: string
  value: string
  source: FactSource
}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: existingRows } = await c.query(
      `SELECT id, value, confidence, observed_count FROM plannen.profile_facts
       WHERE user_id = $1 AND subject = $2 AND predicate = $3 AND is_historical = false`,
      [id, args.subject, args.predicate],
    )
    const existing = existingRows[0] as
      | { id: string; value: string; confidence: number; observed_count: number }
      | undefined

    if (!existing) {
      await c.query(
        `INSERT INTO plannen.profile_facts
           (user_id, subject, predicate, value, confidence, observed_count, source)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [id, args.subject, args.predicate, args.value, initialConfidence(args.source), args.source],
      )
      return { action: 'inserted' }
    }

    if (existing.value === args.value) {
      const newConfidence = computeCorroborationConfidence(existing.confidence)
      await c.query(
        `UPDATE plannen.profile_facts
         SET confidence = $1, observed_count = $2, last_seen_at = $3
         WHERE id = $4`,
        [newConfidence, existing.observed_count + 1, new Date().toISOString(), existing.id],
      )
      return { action: 'corroborated', confidence: newConfidence }
    }

    const decayedConfidence = computeContradictionConfidence(existing.confidence)
    await c.query(
      `UPDATE plannen.profile_facts
       SET confidence = $1, is_historical = $2
       WHERE id = $3`,
      [decayedConfidence, shouldMarkHistorical(decayedConfidence), existing.id],
    )

    await c.query(
      `INSERT INTO plannen.profile_facts
         (user_id, subject, predicate, value, confidence, observed_count, source)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [id, args.subject, args.predicate, args.value, initialConfidence(args.source), args.source],
    )
    return { action: 'contradicted', old_value: existing.value, new_value: args.value }
  })
}

async function correctProfileFact(args: {
  subject: string
  predicate: string
  old_value: string
  new_value: string
}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: existingRows } = await c.query(
      `SELECT id FROM plannen.profile_facts
       WHERE user_id = $1 AND subject = $2 AND predicate = $3
         AND value = $4 AND is_historical = false`,
      [id, args.subject, args.predicate, args.old_value],
    )
    const existing = existingRows[0] as { id: string } | undefined

    if (existing) {
      await c.query(
        'UPDATE plannen.profile_facts SET is_historical = true WHERE id = $1',
        [existing.id],
      )
    }

    await c.query(
      `INSERT INTO plannen.profile_facts
         (user_id, subject, predicate, value, confidence, observed_count, source)
       VALUES ($1, $2, $3, $4, 1.0, 1, 'user_stated')`,
      [id, args.subject, args.predicate, args.new_value],
    )
    return { action: 'corrected', old_value: args.old_value, new_value: args.new_value }
  })
}

async function listProfileFacts(args: { subject?: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const params: unknown[] = [id]
    let subjectClause = ''
    if (args.subject) {
      params.push(args.subject)
      subjectClause = ` AND subject = $${params.length}`
    }
    const { rows } = await c.query(
      `SELECT subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at
       FROM plannen.profile_facts
       WHERE user_id = $1 AND is_historical = false AND confidence >= 0.6${subjectClause}
       ORDER BY subject ASC, predicate ASC`,
      params,
    )
    return rows
  })
}

async function getHistoricalFacts(args: { subject?: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const params: unknown[] = [id]
    let subjectClause = ''
    if (args.subject) {
      params.push(args.subject)
      subjectClause = ` AND subject = $${params.length}`
    }
    const { rows } = await c.query(
      `SELECT subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at
       FROM plannen.profile_facts
       WHERE user_id = $1 AND is_historical = true${subjectClause}
       ORDER BY subject ASC, last_seen_at DESC`,
      params,
    )
    return rows
  })
}

// ── Practices ─────────────────────────────────────────────────────────────────

async function listPractices(args: { active_only?: boolean; family_member_id?: string | null } = {}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [id]
    if (args.active_only) where.push('active = true')
    if (args.family_member_id !== undefined) {
      params.push(args.family_member_id)
      where.push(`family_member_id ${args.family_member_id === null ? 'IS NULL' : '= $' + params.length}`)
    }
    const { rows } = await c.query(
      `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
              dtstart::text, recurrence_until::text, flex_period, flex_target,
              preferred_time_of_day, active, created_at, updated_at
       FROM plannen.practices
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
      params,
    )
    return rows
  })
}

type PracticeInput = {
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule?: { frequency: 'daily' | 'weekly' | 'monthly'; interval?: number; days?: string[] } | null
  dtstart?: string | null
  recurrence_until?: string | null
  flex_period?: 'week' | 'month' | null
  flex_target?: number | null
  preferred_time_of_day?: 'morning' | 'afternoon' | 'evening' | 'anytime'
  family_member_id?: string | null
}

async function createPractice(args: PracticeInput) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.practices
         (user_id, family_member_id, name, category, recurrence_mode,
          recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
          preferred_time_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10, COALESCE($11, 'anytime'))
       RETURNING *`,
      [
        id,
        args.family_member_id ?? null,
        args.name,
        args.category,
        args.recurrence_mode,
        args.recurrence_rule ? JSON.stringify(args.recurrence_rule) : null,
        args.dtstart ?? null,
        args.recurrence_until ?? null,
        args.flex_period ?? null,
        args.flex_target ?? null,
        args.preferred_time_of_day ?? null,
      ],
    )
    return rows[0]
  })
}

async function updatePractice(args: { id: string } & Partial<PracticeInput> & { active?: boolean }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const sets: string[] = []
    const params: unknown[] = []
    const entries = Object.entries(args).filter(([k, v]) => k !== 'id' && v !== undefined)
    for (const [k, v] of entries) {
      params.push(v)
      sets.push(`${k} = $${params.length}`)
    }
    if (sets.length === 0) throw new Error('no fields to update')
    params.push(args.id, userId)
    const { rows } = await c.query(
      `UPDATE plannen.practices SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new Error('practice not found')
    return rows[0]
  })
}

async function deletePractice(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE plannen.practices SET active = false
       WHERE id = $1 AND user_id = $2`,
      [args.id, userId],
    )
    if (rowCount === 0) throw new Error('practice not found')
    return { ok: true }
  })
}

async function markPracticeDone(args: {
  practice_id: string
  completed_on?: string
  family_member_id?: string | null
}) {
  const userId = await uid()
  const date = args.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    // Verify ownership (RLS handles it, but a 404 is friendlier than a silent no-op).
    const { rows: ownRows } = await c.query(
      `SELECT 1 FROM plannen.practices WHERE id = $1 AND user_id = $2`,
      [args.practice_id, userId],
    )
    if (ownRows.length === 0) throw new Error('practice not found')
    // The schema has TWO partial unique indexes (one where family_member_id is
    // NOT NULL, one where it IS NULL) because Postgres treats NULLs as distinct
    // in a single UNIQUE constraint. ON CONFLICT without a target lets Postgres
    // pick whichever partial index matches the row being inserted.
    await c.query(
      `INSERT INTO plannen.practice_completions
         (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [args.practice_id, userId, args.family_member_id ?? null, date],
    )
    return { ok: true, practice_id: args.practice_id, completed_on: date }
  })
}

async function unmarkPracticeDone(args: {
  practice_id: string
  completed_on?: string
  family_member_id?: string | null
}) {
  const userId = await uid()
  const date = args.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    await c.query(
      `DELETE FROM plannen.practice_completions
       WHERE practice_id = $1
         AND user_id = $2
         AND completed_on = $3
         AND family_member_id IS NOT DISTINCT FROM $4`,
      [args.practice_id, userId, date, args.family_member_id ?? null],
    )
    return { ok: true, practice_id: args.practice_id, completed_on: date }
  })
}

// ── Attendances + blackouts ───────────────────────────────────────────────────

type AttendanceInput = {
  family_member_id: string
  name: string
  location_id?: string | null
  recurrence_rule: { frequency: 'daily' | 'weekly' | 'monthly'; interval?: number; days?: string[] }
  dtstart?: string | null
  recurrence_until?: string | null
  time_of_day?: string | null
  start_time?: string | null
  end_time?: string | null
  priority?: number | null
}

async function createAttendance(args: AttendanceInput) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.attendances
         (user_id, family_member_id, name, location_id, recurrence_rule,
          dtstart, recurrence_until, time_of_day, start_time, end_time, priority)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, current_date), $7, $8, $9, $10, COALESCE($11, 0))
       RETURNING *`,
      [
        id,
        args.family_member_id,
        args.name,
        args.location_id ?? null,
        JSON.stringify(args.recurrence_rule),
        args.dtstart ?? null,
        args.recurrence_until ?? null,
        args.time_of_day ?? null,
        args.start_time ?? null,
        args.end_time ?? null,
        args.priority ?? null,
      ],
    )
    return rows[0]
  })
}

async function updateAttendance(args: { id: string } & Partial<AttendanceInput> & { active?: boolean }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const sets: string[] = []
    const params: unknown[] = []
    const entries = Object.entries(args).filter(([k, v]) => k !== 'id' && v !== undefined)
    for (const [k, v] of entries) {
      params.push(v)
      sets.push(`${k} = $${params.length}`)
    }
    if (sets.length === 0) throw new Error('no fields to update')
    params.push(args.id, userId)
    const { rows } = await c.query(
      `UPDATE plannen.attendances SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new Error('attendance not found')
    return rows[0]
  })
}

async function listAttendances(args: { family_member_id?: string; active_only?: boolean } = {}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [id]
    if (args.family_member_id !== undefined) {
      params.push(args.family_member_id)
      where.push(`family_member_id = $${params.length}`)
    }
    if (args.active_only) where.push('active = true')
    const { rows } = await c.query(
      `SELECT id, family_member_id, name, location_id, recurrence_rule,
              dtstart::text, recurrence_until::text, time_of_day, start_time, end_time,
              priority, active, created_at, updated_at
       FROM plannen.attendances
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
      params,
    )
    return rows
  })
}

async function deleteAttendance(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE plannen.attendances SET active = false
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [args.id, userId],
    )
    if (rowCount === 0) throw new Error('attendance not found')
    return { ok: true }
  })
}

async function createBlackoutCalendar(args: { name: string; family_member_id?: string | null }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.blackout_calendars (user_id, family_member_id, name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, args.family_member_id ?? null, args.name],
    )
    return rows[0]
  })
}

async function addBlackoutWindow(args: {
  calendar_id: string
  starts_on: string
  ends_on: string
  label?: string | null
}) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows: ownRows } = await c.query(
      `SELECT 1 FROM plannen.blackout_calendars WHERE id = $1 AND user_id = $2`,
      [args.calendar_id, userId],
    )
    if (ownRows.length === 0) throw new Error('calendar not found')
    const { rows } = await c.query(
      `INSERT INTO plannen.blackout_windows (user_id, calendar_id, starts_on, ends_on, label)
       VALUES ($1, $2, $3::date, $4::date, $5)
       RETURNING *`,
      [userId, args.calendar_id, args.starts_on, args.ends_on, args.label ?? null],
    )
    return rows[0]
  })
}

async function listBlackoutCalendars() {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: calendars } = await c.query(
      `SELECT id, family_member_id, name, active, created_at, updated_at
       FROM plannen.blackout_calendars
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [id],
    )
    const { rows: windows } = await c.query(
      `SELECT id, calendar_id, starts_on::text, ends_on::text, label, created_at
       FROM plannen.blackout_windows
       WHERE user_id = $1
       ORDER BY starts_on ASC`,
      [id],
    )
    const byCalendar = new Map<string, unknown[]>()
    for (const w of windows as Array<{ calendar_id: string }>) {
      const list = byCalendar.get(w.calendar_id) ?? []
      list.push(w)
      byCalendar.set(w.calendar_id, list)
    }
    return (calendars as Array<{ id: string }>).map((cal) => ({
      ...cal,
      windows: byCalendar.get(cal.id) ?? [],
    }))
  })
}

async function linkAttendanceBlackout(args: { attendance_id: string; calendar_id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows: attRows } = await c.query(
      `SELECT 1 FROM plannen.attendances WHERE id = $1 AND user_id = $2`,
      [args.attendance_id, userId],
    )
    if (attRows.length === 0) throw new Error('attendance not found')
    const { rows: calRows } = await c.query(
      `SELECT 1 FROM plannen.blackout_calendars WHERE id = $1 AND user_id = $2`,
      [args.calendar_id, userId],
    )
    if (calRows.length === 0) throw new Error('calendar not found')
    await c.query(
      `INSERT INTO plannen.attendance_blackouts (attendance_id, calendar_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (attendance_id, calendar_id) DO NOTHING`,
      [args.attendance_id, args.calendar_id, userId],
    )
    return { ok: true }
  })
}

// ── Obligations (derived drop/pick tasks linked to attendances) ────────────────

type ObligationInput = {
  derived_from_attendance_id: string
  role: 'drop' | 'pick'
  anchor: 'start' | 'end'
  offset_minutes?: number | null
  location_id?: string | null
}

async function createObligation(args: ObligationInput) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows: attRows } = await c.query(
      `SELECT 1 FROM plannen.attendances WHERE id = $1 AND user_id = $2`,
      [args.derived_from_attendance_id, userId],
    )
    if (attRows.length === 0) throw new Error('attendance not found')
    const { rows } = await c.query(
      `INSERT INTO plannen.obligations
         (user_id, derived_from_attendance_id, role, anchor, offset_minutes, location_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6)
       RETURNING *`,
      [
        userId,
        args.derived_from_attendance_id,
        args.role,
        args.anchor,
        args.offset_minutes ?? null,
        args.location_id ?? null,
      ],
    )
    return rows[0]
  })
}

async function updateObligation(args: { id: string } & Partial<ObligationInput> & { active?: boolean }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const sets: string[] = []
    const params: unknown[] = []
    const entries = Object.entries(args).filter(([k, v]) => k !== 'id' && v !== undefined)
    for (const [k, v] of entries) {
      params.push(v)
      sets.push(`${k} = $${params.length}`)
    }
    if (sets.length === 0) throw new Error('no fields to update')
    params.push(args.id, userId)
    const { rows } = await c.query(
      `UPDATE plannen.obligations SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new Error('obligation not found')
    return rows[0]
  })
}

async function listObligations(args: { attendance_id?: string; active_only?: boolean } = {}) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [userId]
    if (args.attendance_id !== undefined) {
      params.push(args.attendance_id)
      where.push(`derived_from_attendance_id = $${params.length}`)
    }
    if (args.active_only) where.push('active = true')
    const { rows } = await c.query(
      `SELECT id, derived_from_attendance_id, role, anchor, offset_minutes,
              location_id, active, created_at, updated_at
       FROM plannen.obligations
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
      params,
    )
    return rows
  })
}

async function deleteObligation(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE plannen.obligations SET active = false
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [args.id, userId],
    )
    if (rowCount === 0) throw new Error('obligation not found')
    return { ok: true }
  })
}

/**
 * Composite read for the daily briefing. `args.date` is a UTC calendar date
 * (`YYYY-MM-DD`); pass `new Date().toISOString().slice(0, 10)` from the
 * caller. A locale-derived date string may resolve to the wrong day for users
 * far from UTC.
 */
async function getBriefingContext(args: { date?: string } = {}) {
  const userId = await uid()
  const today = args.date ?? new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`)
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7)
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10)
  const wkStart = weekBoundaryStart(today)
  const monthStart = `${today.slice(0, 7)}-01`
  const completionsFrom = monthStart < wkStart ? monthStart : wkStart

  return await withUserContext(userId, async (c) => {
    const [userRow, circleRow, primaryCircleUsersRow, eventsTodayRow, eventsTomorrowRow, recentPastRow, practicesRow, completionsRow, locationsRow, attendancesRow, blackoutsRow] =
      await Promise.all([
        c.query(
          `SELECT u.id, u.full_name, u.preferred_language, up.timezone, up.primary_circle_group_ids
           FROM plannen.users u
           LEFT JOIN plannen.user_profiles up ON up.user_id = u.id
           WHERE u.id = $1`,
          [userId],
        ),
        c.query(
          `SELECT id, name, relation, dob, gender, goals, interests
           FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        c.query(
          `SELECT DISTINCT u.id, u.full_name, u.email
             FROM plannen.user_profiles up
             JOIN plannen.friend_group_members fgm
               ON fgm.group_id = ANY(up.primary_circle_group_ids)
             JOIN plannen.users u ON u.id = fgm.user_id
            WHERE up.user_id = $1
              AND u.id <> $1`,
          [userId],
        ),
        c.query(
          `SELECT id, title, start_date, end_date, location, event_kind, hashtags
           FROM plannen.events
           WHERE created_by = $1 AND start_date::date = $2::date
             AND event_status <> 'cancelled'
           ORDER BY start_date ASC`,
          [userId, today],
        ),
        c.query(
          `SELECT id, title, start_date, end_date, location, event_kind, hashtags
           FROM plannen.events
           WHERE created_by = $1 AND start_date::date = $2::date
             AND event_status <> 'cancelled'
           ORDER BY start_date ASC`,
          [userId, tomorrowStr],
        ),
        c.query(
          `SELECT id, title, start_date, location, event_kind
           FROM plannen.events
           WHERE created_by = $1
             AND start_date::date BETWEEN $2::date AND ($3::date - INTERVAL '1 day')::date
             AND event_status <> 'cancelled'
           ORDER BY start_date DESC LIMIT 10`,
          [userId, sevenDaysAgoStr, today],
        ),
        c.query(
          `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
                  dtstart::text, recurrence_until::text, flex_period, flex_target,
                  preferred_time_of_day, active
           FROM plannen.practices WHERE user_id = $1 AND active = true`,
          [userId],
        ),
        c.query(
          `SELECT practice_id, completed_on::text
           FROM plannen.practice_completions
           WHERE user_id = $1 AND completed_on >= $2::date`,
          [userId, completionsFrom],
        ),
        c.query(
          `SELECT id, label, city, country, is_default
           FROM plannen.user_locations WHERE user_id = $1`,
          [userId],
        ),
        c.query(
          `SELECT id, family_member_id, name, location_id, recurrence_rule,
                  dtstart::text, recurrence_until::text, start_time, end_time, priority, active
           FROM plannen.attendances WHERE user_id = $1 AND active = true`,
          [userId],
        ),
        c.query(
          `SELECT ab.attendance_id, w.calendar_id, w.starts_on::text AS starts_on,
                  w.ends_on::text AS ends_on, w.label
           FROM plannen.attendance_blackouts ab
           JOIN plannen.blackout_windows w ON w.calendar_id = ab.calendar_id
           WHERE ab.user_id = $1`,
          [userId],
        ),
      ])

    type CRow = { practice_id: string; completed_on: string }
    const allCompletions = completionsRow.rows as CRow[]
    const practicesDue = (practicesRow.rows as Parameters<typeof isPracticeDueOn>[0][])
      .filter((p) => isPracticeDueOn(p, today, allCompletions))
      .map((p) => {
        const inPeriod = allCompletions.filter((c) => c.practice_id === p.id).length
        return {
          ...p,
          completions_this_period: inPeriod,
          remaining_this_period: remainingThisPeriod(p, today, allCompletions),
        }
      })

    const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long', timeZone: 'UTC',
    })

    const windowsMap = new Map<string, BlackoutWindow[]>()
    for (const w of blackoutsRow.rows as (BlackoutWindow & { attendance_id: string })[]) {
      const list = windowsMap.get(w.attendance_id) ?? []
      list.push(w)
      windowsMap.set(w.attendance_id, list)
    }
    const attendancesToday = (attendancesRow.rows as AttendanceRow[]).flatMap((att) =>
      expandAndSuppress(att, windowsMap.get(att.id) ?? [], today, today),
    )

    return {
      date: today,
      weekday,
      user: userRow.rows[0] ?? { id: userId },
      circle: circleRow.rows,
      primary_circle_users: primaryCircleUsersRow.rows,
      events_today: eventsTodayRow.rows,
      events_tomorrow: eventsTomorrowRow.rows,
      recent_past_events: recentPastRow.rows,
      practices_due_today: practicesDue,
      locations: locationsRow.rows,
      attendances_today: attendancesToday,
    }
  })
}

async function saveDailyBriefing(args: {
  briefing_date: string
  content_md: string
  summary?: string | null
  source: 'claude_code' | 'claude_desktop' | 'web' | 'cron'
}) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.daily_briefings
         (user_id, briefing_date, content_md, summary, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, briefing_date) DO UPDATE
         SET content_md = EXCLUDED.content_md,
             summary = EXCLUDED.summary,
             source = EXCLUDED.source,
             generated_at = now()
       RETURNING *`,
      [userId, args.briefing_date, args.content_md, args.summary ?? null, args.source],
    )
    return rows[0]
  })
}

async function getDailyBriefing(args: { date?: string } = {}) {
  const userId = await uid()
  const date = args.date ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, briefing_date::text, content_md, summary, source, generated_at
       FROM plannen.daily_briefings
       WHERE user_id = $1 AND briefing_date = $2::date`,
      [userId, date],
    )
    return rows[0] ?? null
  })
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
        start_date: { type: 'string', description: 'ISO 8601. Timezone-naive values (e.g. 2026-06-15T10:00:00) are interpreted in your profile timezone; explicit offsets/Z are respected.' },
        end_date: { type: 'string', description: 'ISO 8601 (naive = profile timezone) or omit' },
        location: { type: 'string' },
        event_kind: { type: 'string', enum: ['event', 'reminder', 'todo'] },
        assigned_to: { type: 'string', description: 'User UUID to assign a todo to (defaults to creator). Only meaningful for event_kind=todo.' },
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
    name: 'complete_todo',
    description: 'Mark a todo (event_kind=todo) as done. Sets completed_at.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Todo (event) UUID' },
        completed_at: { type: 'string', description: 'ISO 8601 completion time (default: now)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'uncomplete_todo',
    description: 'Re-open a completed todo. Clears completed_at.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Todo (event) UUID' } },
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
    description: 'List memories attached to one or more events, ordered by event_id ASC, then taken_at ASC (NULLS LAST), then created_at ASC. Pass event_id for a single event, or event_ids for a batch (e.g. composing a story across multiple events). Returns id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at. The transcript field is populated for audio memories that have been transcribed via transcribe_memory; null otherwise. Use it for story context.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'Single event UUID. Mutually exclusive with event_ids.' },
        event_ids: { type: 'array', items: { type: 'string' }, description: 'Multiple event UUIDs to batch in one call. Takes precedence over event_id.' },
      },
    },
  },
  {
    name: 'list_event_notes',
    description: 'List free-text notes attached to one or more events, ordered by event_id ASC, then created_at ASC. Shared events accept notes from any user who can see the event, so a single event can have multiple notes from multiple authors. Returns id, event_id, user_id, body, created_at, updated_at, author_full_name, author_email. Use this alongside list_event_memories when composing a story so the AI weaves in each author\'s observations.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'Single event UUID. Mutually exclusive with event_ids.' },
        event_ids: { type: 'array', items: { type: 'string' }, description: 'Multiple event UUIDs to batch in one call. Takes precedence over event_id.' },
      },
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
    description: "List the current user's stories, ordered by generated_at DESC. Each row includes a small events array for subtitles. Pass story_group_id to restrict the result to a single translation group (used when fetching siblings for a story reader).",
    inputSchema: {
      type: 'object',
      properties: {
        limit:           { type: 'number', description: 'Default 50' },
        offset:          { type: 'number', description: 'Default 0' },
        story_group_id:  { type: 'string', description: 'Optional: restrict to one translation group.' },
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
    description: "List your accepted connections in Plannen (real Plannen users you're connected to).",
    inputSchema: {
      type: 'object',
      properties: {},
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
        value: { type: 'string', description: 'The fact value, e.g. "football", "Linde school", "peanuts", "mornings"' },
        source: { type: 'string', enum: ['agent_inferred', 'user_stated'], description: 'agent_inferred for conclusions drawn by Claude; user_stated when the user said it explicitly' },
      },
      required: ['subject', 'predicate', 'value', 'source'],
    },
  },
  {
    name: 'list_practices',
    description: 'List your practices (recurring routines like gym 3×/week, vitamin D daily). Returns rows with recurrence_mode, recurrence_rule, flex_period, flex_target, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'Only return active=true rows (default false).' },
        family_member_id: { type: 'string', description: 'Filter to practices owned by this circle member. Pass null for unowned (self).' },
      },
    },
  },
  {
    name: 'create_practice',
    description: 'Create a recurring routine. recurrence_mode="pinned" for date-cadence routines (every other day, weekdays, monthly — set recurrence_rule); recurrence_mode="flex_count" for "N times per week/month, anytime" (gym 3×/week — set flex_period + flex_target). For time-pinned attendance like a school drop-off, use a recurring event/attendance instead, not a practice.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
        recurrence_mode: { type: 'string', enum: ['pinned', 'flex_count'],
          description: "'pinned' = fires on specific recurring dates (use recurrence_rule); 'flex_count' = N times per week/month, anytime (use flex_period + flex_target)." },
        recurrence_rule: { type: 'object',
          description: "Required when recurrence_mode='pinned'. { frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }. Examples: every other day = {frequency:'daily',interval:2}; weekdays = {frequency:'weekly',days:['MO','TU','WE','TH','FR']}; monthly = {frequency:'monthly'}.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string', description: 'YYYY-MM-DD anchor/start date. Defaults to today. For every-N-days this is the date the cadence counts from.' },
        recurrence_until: { type: 'string', description: 'Optional YYYY-MM-DD end date for the recurrence.' },
        flex_period: { type: 'string', enum: ['week', 'month'], description: "Required when recurrence_mode='flex_count'." },
        flex_target: { type: 'number', description: "Required when recurrence_mode='flex_count'. Completions per period, 1–31 (e.g. gym 3×/week = period 'week', target 3)." },
        preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
        family_member_id: { type: ['string', 'null'], description: 'Optional — owner is a circle member rather than the user themselves.' },
      },
      required: ['name', 'category', 'recurrence_mode'],
    },
  },
  {
    name: 'update_practice',
    description: 'Update fields on an existing practice.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
        recurrence_mode: { type: 'string', enum: ['pinned', 'flex_count'],
          description: "'pinned' = fires on specific recurring dates (use recurrence_rule); 'flex_count' = N times per week/month, anytime (use flex_period + flex_target)." },
        recurrence_rule: { type: 'object',
          description: "Required when recurrence_mode='pinned'. { frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }. Examples: every other day = {frequency:'daily',interval:2}; weekdays = {frequency:'weekly',days:['MO','TU','WE','TH','FR']}; monthly = {frequency:'monthly'}.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string', description: 'YYYY-MM-DD anchor/start date. Defaults to today. For every-N-days this is the date the cadence counts from.' },
        recurrence_until: { type: 'string', description: 'Optional YYYY-MM-DD end date for the recurrence.' },
        flex_period: { type: 'string', enum: ['week', 'month'], description: "Required when recurrence_mode='flex_count'." },
        flex_target: { type: 'number', description: "Required when recurrence_mode='flex_count'. Completions per period, 1–31 (e.g. gym 3×/week = period 'week', target 3)." },
        preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
        family_member_id: { type: ['string', 'null'] },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_practice',
    description: 'Soft-delete a practice (sets active=false). The row is preserved so historical completion stats remain meaningful.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'mark_practice_done',
    description: 'Log a completion for a practice on a date (defaults to today). Idempotent — calling twice on the same date is a no-op. Pass family_member_id when the practice is owned by a circle member.',
    inputSchema: {
      type: 'object',
      properties: {
        practice_id: { type: 'string' },
        completed_on: { type: 'string', description: 'ISO date YYYY-MM-DD; defaults to today.' },
        family_member_id: { type: ['string', 'null'] },
      },
      required: ['practice_id'],
    },
  },
  {
    name: 'unmark_practice_done',
    description: 'Remove a logged completion (undo).',
    inputSchema: {
      type: 'object',
      properties: {
        practice_id: { type: 'string' },
        completed_on: { type: 'string' },
        family_member_id: { type: ['string', 'null'] },
      },
      required: ['practice_id'],
    },
  },
  {
    name: 'create_attendance',
    description: 'Record that a family member attends a place on a recurring schedule (school, creche, camp). Indicative context only — never auto-actioned and excluded from conflict checks. Drop/pick are separate linked obligations (create_obligation).',
    inputSchema: {
      type: 'object',
      properties: {
        family_member_id: { type: 'string' },
        name: { type: 'string' },
        location_id: { type: ['string', 'null'] },
        recurrence_rule: { type: 'object',
          description: "{ frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }. Examples: every other day = {frequency:'daily',interval:2}; weekdays = {frequency:'weekly',days:['MO','TU','WE','TH','FR']}; monthly = {frequency:'monthly'}.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string' },
        recurrence_until: { type: 'string', description: 'NULL/omitted = open-ended enrolment like a school term; set a date for a bounded enrolment like a camp week — bounded wins override resolution for its window.' },
        time_of_day: { type: 'string' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_time: { type: 'string', description: 'HH:MM' },
        priority: { type: 'number', description: 'Higher wins member overlap; bounded camps seed higher, e.g. 10.' },
      },
      required: ['family_member_id', 'name', 'recurrence_rule'],
    },
  },
  {
    name: 'update_attendance',
    description: 'Update fields on an existing attendance.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        family_member_id: { type: 'string' },
        name: { type: 'string' },
        location_id: { type: ['string', 'null'] },
        recurrence_rule: { type: 'object',
          description: "{ frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string' },
        recurrence_until: { type: 'string', description: 'NULL/omitted = open-ended enrolment like a school term; set a date for a bounded enrolment like a camp week — bounded wins override resolution for its window.' },
        time_of_day: { type: 'string' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_time: { type: 'string', description: 'HH:MM' },
        priority: { type: 'number', description: 'Higher wins member overlap; bounded camps seed higher, e.g. 10.' },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_attendances',
    description: 'List attendances (recurring place enrolments like school, creche, camp). Indicative context only — excluded from conflict checks.',
    inputSchema: {
      type: 'object',
      properties: {
        family_member_id: { type: 'string' },
        active_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_attendance',
    description: 'Soft-delete an attendance (sets active=false).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_obligation',
    description: "A derived drop/pick task linked to an attendance. It stays linked and re-projects onto whichever attendance instance survives blackout suppression and member-overlap override — so drop/pick auto-suppress on holidays and follow the child to a camp.",
    inputSchema: {
      type: 'object',
      properties: {
        derived_from_attendance_id: { type: 'string' },
        role: { type: 'string', enum: ['drop', 'pick'] },
        anchor: { type: 'string', enum: ['start', 'end'], description: "Which end of the attendance the offset is measured from: 'start' for a drop, 'end' for a pick." },
        offset_minutes: { type: 'number', description: 'Signed minutes from the anchor; a drop is negative from start (e.g. -15 = arrive 15m before start), a pick is 0 from end.' },
        location_id: { type: ['string', 'null'], description: 'Optional; defaults to inheriting the attendance/winning-instance location (so it follows the child to a camp).' },
      },
      required: ['derived_from_attendance_id', 'role', 'anchor'],
    },
  },
  {
    name: 'update_obligation',
    description: 'Update fields on an existing obligation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        role: { type: 'string', enum: ['drop', 'pick'] },
        anchor: { type: 'string', enum: ['start', 'end'], description: "Which end of the attendance the offset is measured from: 'start' for a drop, 'end' for a pick." },
        offset_minutes: { type: 'number', description: 'Signed minutes from the anchor; a drop is negative from start (e.g. -15 = arrive 15m before start), a pick is 0 from end.' },
        location_id: { type: ['string', 'null'], description: 'Optional; defaults to inheriting the attendance/winning-instance location (so it follows the child to a camp).' },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_obligations',
    description: 'List derived drop/pick obligations linked to attendances.',
    inputSchema: {
      type: 'object',
      properties: {
        attendance_id: { type: 'string' },
        active_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_obligation',
    description: 'Soft-delete an obligation (sets active=false).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_blackout_calendar',
    description: "A named set of date-range windows (e.g. 'example school holidays') that suppress linked attendance instances.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        family_member_id: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_blackout_window',
    description: "Add an inclusive date-range window to a blackout calendar. Suppresses linked attendance instances on those dates.",
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        starts_on: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        ends_on: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        label: { type: 'string' },
      },
      required: ['calendar_id', 'starts_on', 'ends_on'],
    },
  },
  {
    name: 'list_blackout_calendars',
    description: 'List your blackout calendars, each with its windows array.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'link_attendance_blackout',
    description: "Link a blackout calendar to an attendance so its windows suppress that attendance's instances.",
    inputSchema: {
      type: 'object',
      properties: {
        attendance_id: { type: 'string' },
        calendar_id: { type: 'string' },
      },
      required: ['attendance_id', 'calendar_id'],
    },
  },
  {
    name: 'get_briefing_context',
    description: 'Composite snapshot for composing the daily briefing — events today + tomorrow, recent past events, your circle, practices due today (with weekly remaining counts), and locations. One round-trip. Use this before composing a /plannen-today briefing.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date; defaults to today.' },
      },
    },
  },
  {
    name: 'save_daily_briefing',
    description: 'Persist the composed daily briefing. Upserts on (user_id, briefing_date) — a second save on the same date overwrites. Content is markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        briefing_date: { type: 'string' },
        content_md: { type: 'string' },
        summary: { type: 'string' },
        source: { type: 'string', enum: ['claude_code', 'claude_desktop', 'web', 'cron'] },
      },
      required: ['briefing_date', 'content_md', 'source'],
    },
  },
  {
    name: 'get_daily_briefing',
    description: 'Fetch the persisted briefing for a date (default today). Returns null if none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date; defaults to today.' },
      },
    },
  },
  {
    name: 'list_ignore_rules',
    description: 'List the user\'s mailbox ignore rules. Used by /plannen-mailbox-sync to skip muted senders before classification.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter_id: { type: 'string', description: 'Filter by adapter (e.g. "gmail"). Omit for all adapters.' },
      },
    },
  },
  {
    name: 'add_ignore_rule',
    description: 'Add a mailbox mute rule (sender, whole domain, or domain + subject keyword). Future emails matching this rule are skipped by /plannen-mailbox-sync without LLM classification.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id', 'kind', 'pattern'],
      properties: {
        adapter_id:        { type: 'string', description: '"gmail" today; "icloud"/"imap" once those adapters land.' },
        kind:              { type: 'string', enum: ['sender', 'domain', 'domain_subject'], description: 'sender = exact email; domain = whole sending domain (includes subdomains); domain_subject = domain + subject keyword.' },
        pattern:           { type: 'string', description: 'For kind=sender: full address. For kind=domain or domain_subject: bare domain (e.g. "acmelife.com"). Lowercased server-side.' },
        subject_keyword:   { type: 'string', description: 'Required iff kind=domain_subject. Matched as case-insensitive substring against email subject.' },
        source_event_id:   { type: 'string', description: 'Optional — the Plannen event whose dismissal created this rule.' },
        source_message_id: { type: 'string', description: 'Optional — the originating message ID for audit.' },
        reason:            { type: 'string', description: 'Optional human note.' },
      },
    },
  },
  {
    name: 'delete_ignore_rule',
    description: 'Delete a single ignore rule by id. Used by /plannen-mailbox-rules to unmute a sender.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'bump_ignore_rule_hit',
    description: 'Increment hit_count and set last_hit_at = now() for a rule. /plannen-mailbox-sync calls this each time a muted message is skipped.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'find_matching_mbsync_events',
    description: 'Given a (kind, pattern, subject_keyword) rule spec, returns up to 100 #mbsync events the rule would match. Used by the web mute UI to ask the user whether to retroactively delete prior captures.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'pattern'],
      properties: {
        kind:            { type: 'string', enum: ['sender', 'domain', 'domain_subject'] },
        pattern:         { type: 'string' },
        subject_keyword: { type: 'string', description: 'Required iff kind=domain_subject.' },
      },
    },
  },
  {
    name: 'add_event_provenance',
    description: "Record (or replace) the source that created an event. Called by /plannen-mailbox-sync after each create_event so the web UI can surface sender/subject and the mute UI can match retroactively.",
    inputSchema: {
      type: 'object',
      required: ['event_id', 'source'],
      properties: {
        event_id:          { type: 'string' },
        source:            { type: 'string', description: '"mailbox" today; "manual"/"gcal"/"ics" later.' },
        adapter_id:        { type: 'string' },
        source_message_id: { type: 'string' },
        sender_display:    { type: 'string', description: 'Raw From: header value.' },
        sender_email:      { type: 'string', description: 'Lowercased address.' },
        sender_domain:     { type: 'string', description: 'Lowercased host part.' },
        subject:           { type: 'string' },
      },
    },
  },
  {
    name: 'get_event_provenance',
    description: 'Return the provenance row for an event, or null if none recorded.',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'string' } },
    },
  },
  {
    name: 'get_mailbox_sync_state',
    description: 'Get the last_synced_at checkpoint for an adapter. Returns { last_synced_at: ISO string | null }. /plannen-mailbox-sync reads this at the start of each run to compute the Gmail search-window lower bound.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id'],
      properties: {
        adapter_id: { type: 'string', description: 'e.g. "gmail".' },
      },
    },
  },
  {
    name: 'set_mailbox_sync_state',
    description: 'Upsert the last_synced_at checkpoint for an adapter. /plannen-mailbox-sync calls this at end-of-run with the internalDate of the latest successfully-processed message so the next run skips everything older.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id', 'last_synced_at'],
      properties: {
        adapter_id:     { type: 'string', description: 'e.g. "gmail".' },
        last_synced_at: { type: 'string', description: 'ISO 8601 timestamp (Z-suffixed UTC recommended).' },
      },
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
      case 'complete_todo':      result = await completeTodo(args as Parameters<typeof completeTodo>[0]); break
      case 'uncomplete_todo':    result = await uncompleteTodo(args as Parameters<typeof uncompleteTodo>[0]); break
      case 'rsvp_event':              result = await rsvpEvent(args as Parameters<typeof rsvpEvent>[0]); break
      case 'add_event_memory':        result = await addEventMemory(args as Parameters<typeof addEventMemory>[0]); break
      case 'list_event_memories':     result = await listEventMemories(args as Parameters<typeof listEventMemories>[0]); break
      case 'list_event_notes':        result = await listEventNotes(args as Parameters<typeof listEventNotes>[0]); break
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
      case 'list_practices':   result = await listPractices(args as Parameters<typeof listPractices>[0]); break
      case 'create_practice':  result = await createPractice(args as Parameters<typeof createPractice>[0]); break
      case 'update_practice':  result = await updatePractice(args as Parameters<typeof updatePractice>[0]); break
      case 'delete_practice':  result = await deletePractice(args as Parameters<typeof deletePractice>[0]); break
      case 'mark_practice_done':   result = await markPracticeDone(args as Parameters<typeof markPracticeDone>[0]); break
      case 'unmark_practice_done': result = await unmarkPracticeDone(args as Parameters<typeof unmarkPracticeDone>[0]); break
      case 'create_attendance':         result = await createAttendance(args as Parameters<typeof createAttendance>[0]); break
      case 'update_attendance':         result = await updateAttendance(args as Parameters<typeof updateAttendance>[0]); break
      case 'list_attendances':          result = await listAttendances(args as Parameters<typeof listAttendances>[0]); break
      case 'delete_attendance':         result = await deleteAttendance(args as Parameters<typeof deleteAttendance>[0]); break
      case 'create_obligation':         result = await createObligation(args as Parameters<typeof createObligation>[0]); break
      case 'update_obligation':         result = await updateObligation(args as Parameters<typeof updateObligation>[0]); break
      case 'list_obligations':          result = await listObligations(args as Parameters<typeof listObligations>[0]); break
      case 'delete_obligation':         result = await deleteObligation(args as Parameters<typeof deleteObligation>[0]); break
      case 'create_blackout_calendar':  result = await createBlackoutCalendar(args as Parameters<typeof createBlackoutCalendar>[0]); break
      case 'add_blackout_window':       result = await addBlackoutWindow(args as Parameters<typeof addBlackoutWindow>[0]); break
      case 'list_blackout_calendars':   result = await listBlackoutCalendars(); break
      case 'link_attendance_blackout':  result = await linkAttendanceBlackout(args as Parameters<typeof linkAttendanceBlackout>[0]); break
      case 'get_briefing_context': result = await getBriefingContext(args as Parameters<typeof getBriefingContext>[0]); break
      case 'save_daily_briefing': result = await saveDailyBriefing(args as Parameters<typeof saveDailyBriefing>[0]); break
      case 'get_daily_briefing':  result = await getDailyBriefing(args as Parameters<typeof getDailyBriefing>[0]); break
      case 'list_ignore_rules': {
        const a = args as { adapter_id?: string }
        const adapterId = a.adapter_id ?? null
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const baseCols = `id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason, hit_count, last_hit_at, created_at`
          const sql = adapterId
            ? `SELECT ${baseCols} FROM plannen.mailbox_ignore_rules WHERE user_id = $1 AND adapter_id = $2 ORDER BY created_at DESC`
            : `SELECT ${baseCols} FROM plannen.mailbox_ignore_rules WHERE user_id = $1 ORDER BY created_at DESC`
          const params = adapterId ? [userId, adapterId] : [userId]
          const { rows } = await client.query(sql, params)
          return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
        })
      }
      case 'add_ignore_rule': {
        const a = args as {
          adapter_id?: string
          kind?: 'sender' | 'domain' | 'domain_subject'
          pattern?: string
          subject_keyword?: string
          source_event_id?: string | null
          source_message_id?: string | null
          reason?: string | null
        }
        const adapterId = (a.adapter_id ?? '').trim()
        const kind = a.kind
        const patternRaw = (a.pattern ?? '').trim()
        if (!adapterId) throw new Error('adapter_id required')
        if (kind !== 'sender' && kind !== 'domain' && kind !== 'domain_subject') {
          throw new Error('kind must be one of sender | domain | domain_subject')
        }
        if (!patternRaw) throw new Error('pattern required')
        if (kind === 'domain_subject' && !a.subject_keyword?.trim()) {
          throw new Error('subject_keyword is required when kind=domain_subject')
        }
        if (kind !== 'domain_subject' && a.subject_keyword) {
          throw new Error('subject_keyword is only allowed when kind=domain_subject')
        }
        const pattern = patternRaw.toLowerCase()
        const subjectKeyword = kind === 'domain_subject' ? (a.subject_keyword ?? '').trim() : null
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `INSERT INTO plannen.mailbox_ignore_rules
               (user_id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT ON CONSTRAINT mailbox_ignore_rules_unique_rule DO UPDATE
               SET source_event_id   = COALESCE(EXCLUDED.source_event_id,   plannen.mailbox_ignore_rules.source_event_id),
                   source_message_id = COALESCE(EXCLUDED.source_message_id, plannen.mailbox_ignore_rules.source_message_id),
                   reason            = COALESCE(EXCLUDED.reason,            plannen.mailbox_ignore_rules.reason)
             RETURNING *`,
            [userId, adapterId, kind, pattern, subjectKeyword, a.source_event_id ?? null, a.source_message_id ?? null, a.reason ?? null],
          )
          return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
        })
      }
      case 'delete_ignore_rule': {
        const id = String(args?.id ?? '').trim()
        if (!id) throw new Error('id required')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rowCount } = await client.query(
            `DELETE FROM plannen.mailbox_ignore_rules WHERE id = $1 AND user_id = $2`,
            [id, userId],
          )
          return { content: [{ type: 'text', text: JSON.stringify({ deleted: rowCount ?? 0 }) }] }
        })
      }
      case 'bump_ignore_rule_hit': {
        const id = String(args?.id ?? '').trim()
        if (!id) throw new Error('id required')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `UPDATE plannen.mailbox_ignore_rules
               SET hit_count = hit_count + 1, last_hit_at = now()
               WHERE id = $1 AND user_id = $2
             RETURNING id, hit_count, last_hit_at`,
            [id, userId],
          )
          if (rows.length === 0) throw new Error('rule not found')
          return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
        })
      }
      case 'find_matching_mbsync_events': {
        const a = args as { kind?: string; pattern?: string; subject_keyword?: string }
        const kind = a.kind
        const patternRaw = (a.pattern ?? '').trim()
        if (kind !== 'sender' && kind !== 'domain' && kind !== 'domain_subject') {
          throw new Error('kind must be one of sender | domain | domain_subject')
        }
        if (!patternRaw) throw new Error('pattern required')
        if (kind === 'domain_subject' && !a.subject_keyword?.trim()) {
          throw new Error('subject_keyword is required when kind=domain_subject')
        }
        if (kind !== 'domain_subject' && a.subject_keyword) {
          throw new Error('subject_keyword is only allowed when kind=domain_subject')
        }
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            'SELECT * FROM plannen.find_matching_mbsync_events($1, $2, $3)',
            [kind, patternRaw.toLowerCase(), kind === 'domain_subject' ? (a.subject_keyword ?? '').trim() : null],
          )
          return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
        })
      }
      case 'add_event_provenance': {
        const a = args as {
          event_id?: string
          source?: string
          adapter_id?: string
          source_message_id?: string
          sender_display?: string
          sender_email?: string
          sender_domain?: string
          subject?: string
        }
        const eventId = (a.event_id ?? '').trim()
        const source = (a.source ?? '').trim()
        if (!eventId) throw new Error('event_id required')
        if (!source) throw new Error('source required')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `INSERT INTO plannen.event_provenance
               (event_id, source, adapter_id, source_message_id, sender_display, sender_email, sender_domain, subject)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (event_id) DO UPDATE SET
               source = EXCLUDED.source,
               adapter_id = EXCLUDED.adapter_id,
               source_message_id = EXCLUDED.source_message_id,
               sender_display = EXCLUDED.sender_display,
               sender_email = EXCLUDED.sender_email,
               sender_domain = EXCLUDED.sender_domain,
               subject = EXCLUDED.subject
             RETURNING *`,
            [eventId, source, a.adapter_id ?? null, a.source_message_id ?? null, a.sender_display ?? null, a.sender_email ?? null, a.sender_domain ?? null, a.subject ?? null],
          )
          return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
        })
      }
      case 'get_event_provenance': {
        const a = args as { event_id?: string }
        const eventId = (a.event_id ?? '').trim()
        if (!eventId) throw new Error('event_id required')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `SELECT p.* FROM plannen.event_provenance p
               JOIN plannen.events e ON e.id = p.event_id
              WHERE p.event_id = $1 AND e.created_by = $2`,
            [eventId, userId],
          )
          return { content: [{ type: 'text', text: JSON.stringify(rows[0] ?? null) }] }
        })
      }
      case 'get_mailbox_sync_state': {
        const adapterId = String(args?.adapter_id ?? '').trim()
        if (!adapterId) throw new Error('adapter_id required')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `SELECT last_synced_at FROM plannen.mailbox_sync_state
             WHERE user_id = $1 AND adapter_id = $2`,
            [userId, adapterId],
          )
          const lastSyncedAt = rows[0]?.last_synced_at ?? null
          return { content: [{ type: 'text', text: JSON.stringify({ last_synced_at: lastSyncedAt }) }] }
        })
      }
      case 'set_mailbox_sync_state': {
        const adapterId = String(args?.adapter_id ?? '').trim()
        const lastSyncedAt = String(args?.last_synced_at ?? '').trim()
        if (!adapterId) throw new Error('adapter_id required')
        if (!lastSyncedAt) throw new Error('last_synced_at required')
        if (Number.isNaN(Date.parse(lastSyncedAt))) throw new Error('last_synced_at must be a valid ISO 8601 timestamp')
        const userId = await uid()
        return await withUserContext(userId, async (client: PoolClient) => {
          const { rows } = await client.query(
            `INSERT INTO plannen.mailbox_sync_state (user_id, adapter_id, last_synced_at, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (user_id, adapter_id) DO UPDATE
               SET last_synced_at = EXCLUDED.last_synced_at, updated_at = now()
             RETURNING last_synced_at, updated_at`,
            [userId, adapterId, lastSyncedAt],
          )
          return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
        })
      }
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
  `[plannen-mcp] ready — user: ${USER_EMAIL}  tier: ${PLANNEN_TIER}  db: ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}\n`
)
