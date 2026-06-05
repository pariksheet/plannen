import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2341-2421) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_practices',
    description: 'List your practices (frequency-flex recurring intentions like gym 3×/week, vitamin D daily). Returns rows with frequency_type, target_count, etc.',
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
    description: 'Create a new practice. Use this for recurring intentions that are NOT time-pinned events — gym 3×/week, vitamins daily, dishes 2×/week. Fixed-time recurrences (drop kids at school 08:15) should be recurring events instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
        frequency_type: { type: 'string', enum: ['daily', 'weekly_count', 'specific_days'] },
        target_count: { type: 'number', description: 'Required when frequency_type=weekly_count. Integer 1–7.' },
        days_of_week: { type: 'array', items: { type: 'string', enum: ['mon','tue','wed','thu','fri','sat','sun'] }, description: 'Required when frequency_type=specific_days.' },
        preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
        family_member_id: { type: ['string', 'null'], description: 'Optional — owner is a circle member rather than the user themselves.' },
      },
      required: ['name', 'category', 'frequency_type'],
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
        frequency_type: { type: 'string', enum: ['daily', 'weekly_count', 'specific_days'] },
        target_count: { type: 'number' },
        days_of_week: { type: 'array', items: { type: 'string', enum: ['mon','tue','wed','thu','fri','sat','sun'] } },
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
    `SELECT id, family_member_id, name, category, frequency_type, target_count,
            days_of_week, preferred_time_of_day, active, created_at, updated_at
     FROM plannen.practices
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`,
    params,
  )
  return rows
}

const createPractice: ToolHandler = async (args, ctx) => {
  const a = args as {
    name: string
    category: string
    frequency_type: string
    target_count?: number | null
    days_of_week?: string[] | null
    preferred_time_of_day?: string | null
    family_member_id?: string | null
  }
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.practices
       (user_id, family_member_id, name, category, frequency_type,
        target_count, days_of_week, preferred_time_of_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'anytime'))
     RETURNING *`,
    [
      id,
      a.family_member_id ?? null,
      a.name,
      a.category,
      a.frequency_type,
      a.target_count ?? null,
      a.days_of_week ?? null,
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
