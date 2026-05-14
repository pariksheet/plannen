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
import { generateSessionDates, type RecurrenceRule } from './recurrence.js'
import { whisperAvailable, transcribeAudioBytes, extFromContentType } from './transcribe.js'
import { parseSourceUrl, normaliseTags, validateName, validateSourceType } from './sources.js'

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
}) {
  const id = await uid()
  const tz = await getUserTimezone()
  const startDate = new Date(args.start_date)
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
          shared_with_family, shared_with_friends, recurrence_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, false, 'none', $11)
       RETURNING *`,
      [
        args.title,
        args.description ?? null,
        args.start_date,
        args.end_date ?? null,
        args.location ?? null,
        args.event_kind === 'reminder' ? 'reminder' : 'event',
        args.enrollment_url ?? null,
        hashtags,
        event_status,
        id,
        args.recurrence_rule ?? null,
      ],
    )
    if (rows.length === 0) throw new Error('Insert failed')
    const data = rows[0] as Record<string, unknown> & { id: string }

    if (args.recurrence_rule) {
      const dates = generateSessionDates(args.start_date, args.recurrence_rule, tz)
      for (let i = 0; i < dates.length; i++) {
        const d = dates[i]
        await c.query(
          `INSERT INTO plannen.events
             (title, description, start_date, end_date, location, event_kind,
              event_type, event_status, created_by, parent_event_id,
              shared_with_family, shared_with_friends, hashtags)
           VALUES ($1, $2, $3, $4, $5, 'session', 'personal', $6, $7, $8, false, 'none', $9)`,
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

async function listEventMemories(args: { event_id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows: evtRows } = await c.query(
      'SELECT id, created_by FROM plannen.events WHERE id = $1',
      [args.event_id],
    )
    if (evtRows.length === 0) throw new Error('Not found')
    if ((evtRows[0] as { created_by: string }).created_by !== userId) throw new Error('Event not found')
    const { rows } = await c.query(
      `SELECT id, event_id, media_url, media_type, caption, taken_at, created_at,
              external_id, source, transcript, transcript_lang, transcribed_at
       FROM plannen.event_memories
       WHERE event_id = $1
       ORDER BY taken_at ASC NULLS LAST, created_at ASC`,
      [args.event_id],
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

async function listStories(args: { limit?: number; offset?: number } = {}) {
  const userId = await uid()
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  return await withUserContext(userId, async (c) => {
    const { rows: storyRows } = await c.query(
      `SELECT * FROM plannen.stories WHERE user_id = $1
       ORDER BY generated_at DESC
       OFFSET $2 LIMIT $3`,
      [userId, offset, limit],
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

async function listRelationships(args: { type?: string }) {
  const id = await uid()
  const types =
    args.type === 'family' ? ['family', 'both']
    : args.type === 'friend' ? ['friend', 'both']
    : ['family', 'friend', 'both']
  return await withUserContext(id, async (c) => {
    const { rows: rels } = await c.query(
      `SELECT user_id, related_user_id, relationship_type
       FROM plannen.relationships
       WHERE (user_id = $1 OR related_user_id = $1)
         AND status = 'accepted'
         AND relationship_type = ANY($2)`,
      [id, types],
    )
    const relList = rels as Array<{ user_id: string; related_user_id: string; relationship_type: string }>
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
        relationship_type: r.relationship_type,
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
    const [profileRes, locationsRes, familyRes, factsRes, historicalRes] = await Promise.all([
      c.query('SELECT dob, goals, interests, timezone FROM plannen.user_profiles WHERE user_id = $1', [id]),
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
  `[plannen-mcp] ready — user: ${USER_EMAIL}  tier: ${PLANNEN_TIER}  db: ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}\n`
)
