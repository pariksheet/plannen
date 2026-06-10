import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2341-2421) ───────────────

const definitions: ToolDefinition[] = [
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
]

// ── Handlers ──────────────────────────────────────────────────────────────────

const listPractices: ToolHandler = async (args, ctx) => {
  const a = args as { active_only?: boolean; family_member_id?: string | null }
  const id = ctx.userId
  const where: string[] = ['user_id = $1']
  const params: unknown[] = [id]
  if (a.active_only) where.push('active = true')
  if (a.family_member_id !== undefined) {
    params.push(a.family_member_id)
    where.push(`family_member_id ${a.family_member_id === null ? 'IS NULL' : '= $' + params.length}`)
  }
  const { rows } = await ctx.client.query(
    `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
            dtstart::text, recurrence_until::text, flex_period, flex_target,
            preferred_time_of_day, active, created_at, updated_at
     FROM plannen.practices
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`,
    params,
  )
  return rows
}

const createPractice: ToolHandler = async (args, ctx) => {
  const a = args as {
    name: string; category: string; recurrence_mode: string
    recurrence_rule?: unknown; dtstart?: string | null; recurrence_until?: string | null
    flex_period?: string | null; flex_target?: number | null
    preferred_time_of_day?: string | null; family_member_id?: string | null
  }
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.practices
       (user_id, family_member_id, name, category, recurrence_mode,
        recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
        preferred_time_of_day)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10, COALESCE($11, 'anytime'))
     RETURNING *`,
    [
      ctx.userId,
      a.family_member_id ?? null,
      a.name,
      a.category,
      a.recurrence_mode,
      a.recurrence_rule ? JSON.stringify(a.recurrence_rule) : null,
      a.dtstart ?? null,
      a.recurrence_until ?? null,
      a.flex_period ?? null,
      a.flex_target ?? null,
      a.preferred_time_of_day ?? null,
    ],
  )
  return rows[0]
}

const updatePractice: ToolHandler = async (args, ctx) => {
  const a = args as Record<string, unknown>
  const userId = ctx.userId
  const sets: string[] = []
  const params: unknown[] = []
  const entries = Object.entries(a).filter(([k, v]) => k !== 'id' && v !== undefined)
  for (const [k, v] of entries) {
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (sets.length === 0) throw new Error('no fields to update')
  params.push(a['id'], userId)
  const { rows } = await ctx.client.query(
    `UPDATE plannen.practices SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING *`,
    params,
  )
  if (rows.length === 0) throw new Error('practice not found')
  return rows[0]
}

const deletePractice: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const userId = ctx.userId
  const { rowCount } = await ctx.client.query(
    `UPDATE plannen.practices SET active = false
     WHERE id = $1 AND user_id = $2`,
    [a.id, userId],
  )
  if (rowCount === 0) throw new Error('practice not found')
  return { ok: true }
}

const markPracticeDone: ToolHandler = async (args, ctx) => {
  const a = args as { practice_id: string; completed_on?: string; family_member_id?: string | null }
  const userId = ctx.userId
  const date = a.completed_on ?? new Date().toISOString().slice(0, 10)
  // Verify ownership (RLS handles it, but a 404 is friendlier than a silent no-op).
  const { rows: ownRows } = await ctx.client.query(
    `SELECT 1 FROM plannen.practices WHERE id = $1 AND user_id = $2`,
    [a.practice_id, userId],
  )
  if (ownRows.length === 0) throw new Error('practice not found')
  // The schema has TWO partial unique indexes (one where family_member_id is
  // NOT NULL, one where it IS NULL) because Postgres treats NULLs as distinct
  // in a single UNIQUE constraint. ON CONFLICT without a target lets Postgres
  // pick whichever partial index matches the row being inserted.
  await ctx.client.query(
    `INSERT INTO plannen.practice_completions
       (practice_id, user_id, family_member_id, completed_on)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [a.practice_id, userId, a.family_member_id ?? null, date],
  )
  return { ok: true, practice_id: a.practice_id, completed_on: date }
}

const unmarkPracticeDone: ToolHandler = async (args, ctx) => {
  const a = args as { practice_id: string; completed_on?: string; family_member_id?: string | null }
  const userId = ctx.userId
  const date = a.completed_on ?? new Date().toISOString().slice(0, 10)
  await ctx.client.query(
    `DELETE FROM plannen.practice_completions
     WHERE practice_id = $1
       AND user_id = $2
       AND completed_on = $3
       AND family_member_id IS NOT DISTINCT FROM $4`,
    [a.practice_id, userId, date, a.family_member_id ?? null],
  )
  return { ok: true, practice_id: a.practice_id, completed_on: date }
}

// ── Module ────────────────────────────────────────────────────────────────────

export const practicesModule: ToolModule = {
  definitions,
  dispatch: {
    list_practices: listPractices,
    create_practice: createPractice,
    update_practice: updatePractice,
    delete_practice: deletePractice,
    mark_practice_done: markPracticeDone,
    unmark_practice_done: unmarkPracticeDone,
  },
}
