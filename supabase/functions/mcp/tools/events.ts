import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import {
  toLocalIso,
  slimEvent,
  truncateDescription,
  upsertSource,
  getUserTimezone,
  SLIM_EVENT_COLUMNS,
  VALID_EVENT_STATUSES,
  type EventStatus,
} from './_shared.ts'
import { generateSessionDates, parseInUserTz, type RecurrenceRule } from '../../_shared/recurrence.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1585-1675) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_events',
    description:
      'List your events in Plannen. Returns a slim row by default; description is truncated to 200 chars + ellipsis. Pass fields:"full" if you need the untruncated description.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'],
          description: 'Filter by status (omit for all)',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
        from_date: {
          type: 'string',
          description: 'ISO date to filter events starting on or after this date, e.g. 2026-05-07',
        },
        to_date: {
          type: 'string',
          description: 'ISO date to filter events starting on or before this date, e.g. 2026-05-07',
        },
        fields: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            'summary (default) truncates description to 200 chars; full returns the untruncated description.',
        },
      },
    },
  },
  {
    name: 'get_event',
    description:
      'Get details of an event by ID. Returns slim columns by default (drops image_url, created_at, updated_at, gcal_event_id, event_type, shared_with_*); pass fields:"full" for everything. Response includes memories: [{id, external_id, source, caption}] for already-attached photos — use external_ids where source="google_photos" as the skip list when scanning Google Photos.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event UUID' },
        fields: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            'summary (default) returns slim columns; full returns every column including image_url, gcal_event_id, timestamps.',
        },
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
        subject_kind: { type: 'string', enum: ['family_member', 'user'], description: "Whose time this event is, if not the owner's. 'family_member' → a family_members id; 'user' → a connected friend's user id. Set together with subject_id." },
        subject_id: { type: 'string', description: 'Id of the subject person (family member or connected user). Set together with subject_kind.' },
        owner_attends: { type: 'boolean', description: "True if the owner is also occupied during this event (so it still counts as a clash). Default false. Only meaningful when a subject is set." },
        enrollment_url: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Tags without # (max 5)' },
        event_status: {
          type: 'string',
          enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'],
          description: 'Initial status (default: going for future, past for past dates)',
        },
        recurrence_rule: {
          type: 'object',
          description: 'For recurring programmes (e.g. weekly sessions). Generates child session events.',
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Every N periods (default 1)' },
            days: {
              type: 'array',
              items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
              description: 'Days for weekly recurrence',
            },
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
        event_status: {
          type: 'string',
          enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'],
        },
        enrollment_url: { type: 'string' },
        subject_kind: { type: 'string', enum: ['family_member', 'user'], description: "Whose time this event is, if not the owner's. 'family_member' → a family_members id; 'user' → a connected friend's user id. Set together with subject_id." },
        subject_id: { type: 'string', description: 'Id of the subject person (family member or connected user). Set together with subject_kind.' },
        owner_attends: { type: 'boolean', description: "True if the owner is also occupied during this event (so it still counts as a clash). Default false. Only meaningful when a subject is set." },
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
    name: 'log_completion',
    description:
      'Capture that the user just finished or did something. CALL THIS IMMEDIATELY, without asking, whenever the user reports completing an activity — even casually or in passing ("just finished gym today", "cleaned the parking", "kids are in bed", "took my vitamins", "called the dentist"). Do NOT merely reply conversationally ("nice, little win!") — a chat reply DROPS the data; you must call this tool, then confirm in one short line ending "· undo?". It resolves server-side, first match wins: (1) an existing open todo matching the title is marked done (no duplicate); (2) else a matching active practice/routine is logged done; (3) else a new completed todo is created. Matching is conservative — it never guesses among ambiguous matches. Returns {action} = completed_todo | marked_practice | logged_todo so you render the right receipt. Do NOT use for: a FUTURE task with a time (use create_event with event_kind=todo); a durable fact about a person/place (use upsert_profile_fact); or questions / intentions / hypotheticals ("should I…", "maybe I will…", "thinking about…") — do nothing for those.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The activity or task finished, e.g. "gym" or "clean the parking". Keep it short and matchable.',
        },
        when: {
          type: 'string',
          description: 'ISO date or datetime it was done (naive = profile timezone). Defaults to now.',
        },
        family_member_id: {
          type: ['string', 'null'],
          description: 'Set when logging a completion for a circle member (practice case).',
        },
      },
      required: ['title'],
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
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const listEvents: ToolHandler = async (args, ctx) => {
  const a = args as {
    status?: string
    limit?: number
    from_date?: string
    to_date?: string
    fields?: 'summary' | 'full'
  }
  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const where: string[] = ['created_by = $1']
  const params: unknown[] = [ctx.userId]
  if (a.status) { params.push(a.status); where.push(`event_status = $${params.length}`) }
  if (a.from_date) { params.push(a.from_date); where.push(`start_date >= $${params.length}`) }
  if (a.to_date) { params.push(a.to_date + 'T24:00:00'); where.push(`start_date < $${params.length}`) }
  params.push(a.limit ?? 10)
  const sql = `SELECT id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline
               FROM plannen.events
               WHERE ${where.join(' AND ')}
               ORDER BY start_date ASC
               LIMIT $${params.length}`
  const { rows } = await ctx.client.query(sql, params)
  const full = a.fields === 'full'
  return rows.map((e: Record<string, unknown>) => ({
    ...e,
    description: full ? e.description : truncateDescription(e.description),
    start_date: e.start_date ? toLocalIso(e.start_date as string, tz) : e.start_date,
    end_date: e.end_date ? toLocalIso(e.end_date as string, tz) : e.end_date,
    user_timezone: tz,
  }))
}

const getEvent: ToolHandler = async (args, ctx) => {
  const a = args as { id: string; fields?: 'summary' | 'full' }
  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const selectCols = a.fields === 'full' ? '*' : SLIM_EVENT_COLUMNS
  const { rows: dataRows } = await ctx.client.query(
    `SELECT ${selectCols} FROM plannen.events WHERE id = $1 AND created_by = $2`,
    [a.id, ctx.userId],
  )
  if (dataRows.length === 0) throw new Error('Not found')
  const data = dataRows[0] as Record<string, unknown>

  const localise = <T extends { start_date?: string | null; end_date?: string | null }>(e: T) => ({
    ...e,
    start_date: e.start_date ? toLocalIso(e.start_date, tz) : e.start_date,
    end_date: e.end_date ? toLocalIso(e.end_date, tz) : e.end_date,
    user_timezone: tz,
  })

  const { rows: memoryRows } = await ctx.client.query(
    'SELECT id, external_id, source, caption FROM plannen.event_memories WHERE event_id = $1',
    [data.id],
  )
  const memories = memoryRows

  // Recurring parent: embed sessions
  if (data.recurrence_rule) {
    const { rows: sessions } = await ctx.client.query(
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
    const { rows: parentRows } = await ctx.client.query(
      'SELECT id, title, start_date, recurrence_rule FROM plannen.events WHERE id = $1',
      [data.parent_event_id],
    )
    if (parentRows.length === 0) throw new Error('Not found')
    const parent = parentRows[0]
    return { ...localise(data as { start_date?: string | null; end_date?: string | null }), parent: localise(parent), memories }
  }

  return { ...data, memories }
}

const createEvent: ToolHandler = async (args, ctx) => {
  const a = args as {
    title?: string
    description?: string
    start_date?: string
    end_date?: string
    location?: string
    event_kind?: string
    assigned_to?: string
    subject_kind?: 'family_member' | 'user'
    subject_id?: string
    owner_attends?: boolean
    enrollment_url?: string
    hashtags?: string[]
    event_status?: string
    recurrence_rule?: RecurrenceRule
  }
  if (!a.title) throw new Error('title is required')
  if (!a.start_date) throw new Error('start_date is required')

  const tz = await getUserTimezone(ctx.client, ctx.userId)
  // Naive timestamps mean wall-clock time in the user's tz — never the server tz.
  const startDate = parseInUserTz(a.start_date, tz)
  const endDate = a.end_date ? parseInUserTz(a.end_date, tz) : null
  const event_status: EventStatus =
    a.event_status && VALID_EVENT_STATUSES.includes(a.event_status as EventStatus)
      ? (a.event_status as EventStatus)
      : startDate < new Date() ? 'past' : 'going'

  const hashtags = (a.hashtags ?? []).slice(0, 5)
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.events
       (title, description, start_date, end_date, location, event_kind,
        enrollment_url, hashtags, event_type, event_status, created_by,
        assigned_to, shared_with_friends, recurrence_rule,
        subject_kind, subject_id, owner_attends)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, 'none', $12, $13, $14, $15)
     RETURNING *`,
    [
      a.title,
      a.description ?? null,
      startDate.toISOString(),
      endDate ? endDate.toISOString() : null,
      a.location ?? null,
      a.event_kind === 'reminder' || a.event_kind === 'todo' ? a.event_kind : 'event',
      a.enrollment_url ?? null,
      hashtags,
      event_status,
      ctx.userId,
      a.event_kind === 'todo' ? (a.assigned_to ?? ctx.userId) : null,
      a.recurrence_rule ?? null,
      a.subject_kind ?? null,
      a.subject_id ?? null,
      a.owner_attends ?? false,
    ],
  )
  if (rows.length === 0) throw new Error('Insert failed')
  const data = rows[0] as Record<string, unknown> & { id: string }

  if (a.recurrence_rule) {
    const dates = generateSessionDates(startDate.toISOString(), a.recurrence_rule, tz)
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]
      await ctx.client.query(
        `INSERT INTO plannen.events
           (title, description, start_date, end_date, location, event_kind,
            event_type, event_status, created_by, parent_event_id,
            shared_with_friends, hashtags)
         VALUES ($1, $2, $3, $4, $5, 'session', 'personal', $6, $7, $8, 'none', $9)`,
        [
          `${a.title} – Session ${i + 1}`,
          a.description ?? null,
          d.start.toISOString(),
          d.end ? d.end.toISOString() : null,
          a.location ?? null,
          event_status,
          ctx.userId,
          data.id,
          hashtags,
        ],
      )
    }
  }

  const source = a.enrollment_url
    ? await upsertSource(ctx.client, ctx.userId, data.id, a.enrollment_url)
    : null

  return { ...slimEvent(data), source }
}

const updateEvent: ToolHandler = async (args, ctx) => {
  const a = args as {
    id: string
    title?: string
    description?: string
    start_date?: string
    end_date?: string
    location?: string
    event_status?: string
    enrollment_url?: string
    subject_kind?: 'family_member' | 'user' | null
    subject_id?: string | null
    owner_attends?: boolean
  }
  const { id: _id, ...rest } = a
  // Naive timestamps mean wall-clock time in the user's tz — never the server tz.
  if (rest.start_date || rest.end_date) {
    const tz = await getUserTimezone(ctx.client, ctx.userId)
    if (rest.start_date) rest.start_date = parseInUserTz(rest.start_date, tz).toISOString()
    if (rest.end_date) rest.end_date = parseInUserTz(rest.end_date, tz).toISOString()
  }
  const entries = Object.entries(rest).filter(([, v]) => v !== undefined)
  const setClauses: string[] = []
  const params: unknown[] = []
  for (const [k, v] of entries) {
    params.push(v)
    setClauses.push(`${k} = $${params.length}`)
  }
  params.push(new Date().toISOString())
  setClauses.push(`updated_at = $${params.length}`)
  params.push(a.id)
  params.push(ctx.userId)
  const sql = `UPDATE plannen.events SET ${setClauses.join(', ')}
               WHERE id = $${params.length - 1} AND created_by = $${params.length}
               RETURNING *`
  const { rows } = await ctx.client.query(sql, params)
  if (rows.length === 0) throw new Error('Not found')
  const data = rows[0] as Record<string, unknown> & { enrollment_url?: string | null }
  const source = data.enrollment_url
    ? await upsertSource(ctx.client, ctx.userId, a.id, data.enrollment_url)
    : null
  return { ...slimEvent(data), source }
}

const completeTodo: ToolHandler = async (args, ctx) => {
  const a = args as { id: string; completed_at?: string }
  const ts = a.completed_at ?? new Date().toISOString()
  const { rows } = await ctx.client.query(
    `UPDATE plannen.events SET completed_at = $1, updated_at = now()
     WHERE id = $2 AND created_by = $3 AND event_kind = 'todo'
     RETURNING *`,
    [ts, a.id, ctx.userId],
  )
  if (rows.length === 0) throw new Error('todo not found')
  return slimEvent(rows[0] as Record<string, unknown>)
}

const uncompleteTodo: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const { rows } = await ctx.client.query(
    `UPDATE plannen.events SET completed_at = NULL, updated_at = now()
     WHERE id = $1 AND created_by = $2 AND event_kind = 'todo'
     RETURNING *`,
    [a.id, ctx.userId],
  )
  if (rows.length === 0) throw new Error('todo not found')
  return slimEvent(rows[0] as Record<string, unknown>)
}

const rsvpEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string; status: string }
  await ctx.client.query(
    `INSERT INTO plannen.event_rsvps (event_id, user_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
    [a.event_id, ctx.userId, a.status],
  )
  return { success: true, event_id: a.event_id, status: a.status }
}

// Journal "I did X" resolver. Conservative single-match: complete an existing
// open todo, else mark a matching active practice done, else log a fresh
// completed todo. Server-side so EVERY surface (mobile included) dedupes
// identically without the client hand-rolling list→filter→complete.
const logCompletion: ToolHandler = async (args, ctx) => {
  const a = args as { title?: string; when?: string; family_member_id?: string | null }
  if (!a.title || !a.title.trim()) throw new Error('title is required')
  const title = a.title.trim()
  const norm = title.toLowerCase()
  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const whenTs = a.when ? parseInUserTz(a.when, tz) : new Date()
  const completedAtIso = whenTs.toISOString()
  const completedOn = a.when && /^\d{4}-\d{2}-\d{2}$/.test(a.when) ? a.when : completedAtIso.slice(0, 10)
  const cutoffMs = whenTs.getTime() + 24 * 60 * 60 * 1000
  const normOf = (v: unknown) => String(v ?? '').trim().toLowerCase()

  // Tier 1 — existing open todo (confident single match only).
  const { rows: todos } = await ctx.client.query(
    `SELECT id, title, start_date FROM plannen.events
     WHERE created_by = $1 AND event_kind = 'todo' AND completed_at IS NULL`,
    [ctx.userId],
  )
  const exact = todos.filter((r) => normOf((r as { title: unknown }).title) === norm)
  let todoMatch: { id: string; title: string } | null = null
  if (exact.length === 1) todoMatch = exact[0] as { id: string; title: string }
  else if (exact.length === 0) {
    const contains = todos.filter((r) => {
      const row = r as { title: unknown; start_date: string | null }
      const notFarFuture = row.start_date == null || new Date(row.start_date).getTime() <= cutoffMs
      return notFarFuture && normOf(row.title).includes(norm)
    })
    if (contains.length === 1) todoMatch = contains[0] as { id: string; title: string }
  }
  if (todoMatch) {
    const { rows } = await ctx.client.query(
      `UPDATE plannen.events SET completed_at = $1, updated_at = now()
       WHERE id = $2 AND created_by = $3 AND event_kind = 'todo'
       RETURNING id, title`,
      [completedAtIso, todoMatch.id, ctx.userId],
    )
    return { action: 'completed_todo', id: rows[0].id, title: rows[0].title }
  }

  // Tier 2 — active practice (confident single match only).
  const practiceParams: unknown[] = [ctx.userId]
  let practiceWhere = 'user_id = $1 AND active = true'
  if (a.family_member_id !== undefined && a.family_member_id !== null) {
    practiceParams.push(a.family_member_id)
    practiceWhere += ` AND family_member_id = $${practiceParams.length}`
  }
  const { rows: practices } = await ctx.client.query(
    `SELECT id, name, family_member_id FROM plannen.practices WHERE ${practiceWhere}`,
    practiceParams,
  )
  type PracticeMatch = { id: string; name: string; family_member_id: string | null }
  const pExact = practices.filter((r) => normOf((r as { name: unknown }).name) === norm)
  let pMatch: PracticeMatch | null = null
  if (pExact.length === 1) pMatch = pExact[0] as PracticeMatch
  else if (pExact.length === 0) {
    const pContains = practices.filter((r) => normOf((r as { name: unknown }).name).includes(norm))
    if (pContains.length === 1) pMatch = pContains[0] as PracticeMatch
  }
  if (pMatch) {
    await ctx.client.query(
      `INSERT INTO plannen.practice_completions (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [pMatch.id, ctx.userId, pMatch.family_member_id ?? null, completedOn],
    )
    return { action: 'marked_practice', practice_id: pMatch.id, name: pMatch.name, completed_on: completedOn }
  }

  // Tier 3 — log a fresh completed todo.
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.events
       (title, start_date, event_kind, event_type, event_status, created_by,
        assigned_to, shared_with_friends, completed_at)
     VALUES ($1, $2, 'todo', 'personal', 'past', $3, $3, 'none', $4)
     RETURNING id, title`,
    [title, completedAtIso, ctx.userId, completedAtIso],
  )
  return { action: 'logged_todo', id: rows[0].id, title: rows[0].title }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const eventsModule: ToolModule = {
  definitions,
  dispatch: {
    list_events: listEvents,
    get_event: getEvent,
    create_event: createEvent,
    update_event: updateEvent,
    complete_todo: completeTodo,
    uncomplete_todo: uncompleteTodo,
    log_completion: logCompletion,
    rsvp_event: rsvpEvent,
  },
}
