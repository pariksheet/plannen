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
import { generateSessionDates, type RecurrenceRule } from '../../_shared/recurrence.ts'

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
        start_date: { type: 'string', description: 'ISO 8601, e.g. 2026-06-15T10:00:00Z' },
        end_date: { type: 'string', description: 'ISO 8601 or omit' },
        location: { type: 'string' },
        event_kind: { type: 'string', enum: ['event', 'reminder'] },
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
    enrollment_url?: string
    hashtags?: string[]
    event_status?: string
    recurrence_rule?: RecurrenceRule
  }
  if (!a.title) throw new Error('title is required')
  if (!a.start_date) throw new Error('start_date is required')

  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const startDate = new Date(a.start_date)
  const event_status: EventStatus =
    a.event_status && VALID_EVENT_STATUSES.includes(a.event_status as EventStatus)
      ? (a.event_status as EventStatus)
      : startDate < new Date() ? 'past' : 'going'

  const hashtags = (a.hashtags ?? []).slice(0, 5)
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.events
       (title, description, start_date, end_date, location, event_kind,
        enrollment_url, hashtags, event_type, event_status, created_by,
        shared_with_family, shared_with_friends, recurrence_rule)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, false, 'none', $11)
     RETURNING *`,
    [
      a.title,
      a.description ?? null,
      a.start_date,
      a.end_date ?? null,
      a.location ?? null,
      a.event_kind === 'reminder' ? 'reminder' : 'event',
      a.enrollment_url ?? null,
      hashtags,
      event_status,
      ctx.userId,
      a.recurrence_rule ?? null,
    ],
  )
  if (rows.length === 0) throw new Error('Insert failed')
  const data = rows[0] as Record<string, unknown> & { id: string }

  if (a.recurrence_rule) {
    const dates = generateSessionDates(a.start_date, a.recurrence_rule, tz)
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]
      await ctx.client.query(
        `INSERT INTO plannen.events
           (title, description, start_date, end_date, location, event_kind,
            event_type, event_status, created_by, parent_event_id,
            shared_with_family, shared_with_friends, hashtags)
         VALUES ($1, $2, $3, $4, $5, 'session', 'personal', $6, $7, $8, false, 'none', $9)`,
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
  }
  const { id: _id, ...rest } = a
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

// ── Module export ─────────────────────────────────────────────────────────────

export const eventsModule: ToolModule = {
  definitions,
  dispatch: {
    list_events: listEvents,
    get_event: getEvent,
    create_event: createEvent,
    update_event: updateEvent,
    rsvp_event: rsvpEvent,
  },
}
