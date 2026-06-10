import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const practices = new Hono<{ Variables: AppVariables }>()

const Category = z.enum(['health', 'household', 'circle', 'focus', 'other'])
const TimeOfDay = z.enum(['morning', 'afternoon', 'evening', 'anytime'])

const RecurrenceMode = z.enum(['pinned', 'flex_count'])
const Freq = z.enum(['daily', 'weekly', 'monthly'])
const DayCode = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
const FlexPeriod = z.enum(['week', 'month'])
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const RecurrenceRule = z.object({
  frequency: Freq,
  interval: z.number().int().min(1).optional(),
  days: z.array(DayCode).optional(),
})

const PracticeInput = z
  .object({
    name: z.string().min(1),
    category: Category,
    recurrence_mode: RecurrenceMode,
    recurrence_rule: RecurrenceRule.nullable().optional(),
    dtstart: IsoDate.nullable().optional(),
    recurrence_until: IsoDate.nullable().optional(),
    flex_period: FlexPeriod.nullable().optional(),
    flex_target: z.number().int().min(1).max(31).nullable().optional(),
    preferred_time_of_day: TimeOfDay.optional(),
    family_member_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (p) =>
      p.recurrence_mode === 'pinned'
        ? !!p.recurrence_rule && p.flex_period == null
        : p.flex_period != null && p.flex_target != null && p.recurrence_rule == null,
    { message: 'pinned requires recurrence_rule; flex_count requires flex_period + flex_target' },
  )

const PracticePatch = z.object({
  name: z.string().min(1).optional(),
  category: Category.optional(),
  recurrence_mode: RecurrenceMode.optional(),
  recurrence_rule: RecurrenceRule.nullable().optional(),
  dtstart: IsoDate.nullable().optional(),
  recurrence_until: IsoDate.nullable().optional(),
  flex_period: FlexPeriod.nullable().optional(),
  flex_target: z.number().int().min(1).max(31).nullable().optional(),
  preferred_time_of_day: TimeOfDay.optional(),
  family_member_id: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
})

const CompletionInput = z.object({
  completed_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  family_member_id: z.string().uuid().nullable().optional(),
})

practices.get('/', async (c) => {
  const userId = c.var.userId
  const activeOnly = c.req.query('active_only') === 'true'
  return await withUserContext(userId, async (db) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [userId]
    if (activeOnly) where.push('active = true')
    const { rows } = await db.query(
      `SELECT * FROM plannen.practices WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
      params,
    )
    return c.json({ data: rows })
  })
})

practices.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = PracticeInput.safeParse(await c.req.json())
  if (!parsed.success)
    throw new HttpError(400, 'VALIDATION', 'Invalid practice', JSON.stringify(parsed.error.issues))
  const p = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.practices
         (user_id, family_member_id, name, category, recurrence_mode,
          recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
          preferred_time_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10,
               COALESCE($11, 'anytime'))
       RETURNING *`,
      [
        userId,
        p.family_member_id ?? null,
        p.name,
        p.category,
        p.recurrence_mode,
        p.recurrence_rule ? JSON.stringify(p.recurrence_rule) : null,
        p.dtstart ?? null,
        p.recurrence_until ?? null,
        p.flex_period ?? null,
        p.flex_target ?? null,
        p.preferred_time_of_day ?? null,
      ],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

practices.get('/completions', async (c) => {
  const userId = c.var.userId
  const since = c.req.query('since')
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new HttpError(400, 'VALIDATION', 'since=YYYY-MM-DD required')
  }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT practice_id, completed_on::text
       FROM plannen.practice_completions
       WHERE user_id = $1 AND completed_on >= $2::date
       ORDER BY completed_on DESC`,
      [userId, since],
    )
    return c.json({ data: rows })
  })
})

practices.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = PracticePatch.safeParse(await c.req.json())
  if (!parsed.success)
    throw new HttpError(
      400,
      'VALIDATION',
      'Invalid practice patch',
      JSON.stringify(parsed.error.issues),
    )
  const sets: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(parsed.data)) {
    // recurrence_rule is a jsonb column — serialise the object so the pg driver
    // binds it as json text rather than a raw JS object.
    params.push(k === 'recurrence_rule' && v != null ? JSON.stringify(v) : v)
    sets.push(`${k} = $${params.length}`)
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.practices SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    return c.json({ data: rows[0] })
  })
})

practices.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE plannen.practices SET active = false WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    return c.body(null, 204)
  })
})

practices.post('/:id/completions', async (c) => {
  const userId = c.var.userId
  const practiceId = c.req.param('id')
  const parsed = CompletionInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success)
    throw new HttpError(
      400,
      'VALIDATION',
      'Invalid completion',
      JSON.stringify(parsed.error.issues),
    )
  const date = parsed.data.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (db) => {
    const { rows: ownRows } = await db.query(
      `SELECT 1 FROM plannen.practices WHERE id = $1 AND user_id = $2`,
      [practiceId, userId],
    )
    if (ownRows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    // ON CONFLICT without a target — the schema has two partial unique indexes
    // (one for non-null family_member_id, one for null). Postgres picks the
    // matching partial index for the inserted row.
    await db.query(
      `INSERT INTO plannen.practice_completions (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [practiceId, userId, parsed.data.family_member_id ?? null, date],
    )
    return c.json({ data: { practice_id: practiceId, completed_on: date } }, 201)
  })
})

practices.delete('/:id/completions/:date', async (c) => {
  const userId = c.var.userId
  const practiceId = c.req.param('id')
  const date = c.req.param('date')
  return await withUserContext(userId, async (db) => {
    await db.query(
      `DELETE FROM plannen.practice_completions
       WHERE practice_id = $1 AND user_id = $2 AND completed_on = $3::date`,
      [practiceId, userId, date],
    )
    return c.body(null, 204)
  })
})
