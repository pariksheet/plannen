// REST surface for watch tasks (plannen.agent_tasks rows where task_type
// is a watch kind). Mirrors the MCP create_watch_task / update_watch_task
// shape so the web "Watching" feed can hit a uniform endpoint.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const watch = new Hono<{ Variables: AppVariables }>()

const CreateWatch = z.object({
  event_id: z.string().uuid(),
  task_type: z.enum(['recurring_check', 'enrollment_monitor']).optional(),
  recurrence_months: z.number().int().nullable().optional(),
  last_occurrence_date: z.string().nullable().optional(),
})

const PatchWatch = z.object({
  status: z.enum(['pending', 'active', 'completed', 'failed']).optional(),
  next_check: z.string().nullable().optional(),
  last_checked_at: z.string().nullable().optional(),
  last_result: z.unknown().optional(),
  last_page_hash: z.string().nullable().optional(),
  fail_count: z.number().int().optional(),
  has_unread_update: z.boolean().optional(),
  update_summary: z.string().nullable().optional(),
  recurrence_months: z.number().int().nullable().optional(),
  last_occurrence_date: z.string().nullable().optional(),
}).strict()

watch.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  const status = c.req.query('status')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = `SELECT t.* FROM plannen.agent_tasks t
               JOIN plannen.events e ON e.id = t.event_id
               WHERE e.created_by = $1`
    if (eventId) { params.push(eventId); sql += ` AND t.event_id = $${params.length}` }
    if (status)  { params.push(status);  sql += ` AND t.status = $${params.length}` }
    sql += ' ORDER BY t.next_check ASC NULLS LAST, t.created_at DESC'
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

watch.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateWatch.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid watch task', JSON.stringify(parsed.error.issues))
  }
  const w = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows: ev } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [w.event_id, userId],
    )
    if (ev.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    const taskType = w.task_type ?? 'recurring_check'
    const cols = ['event_id', 'task_type', 'status', 'next_check']
    const vals: unknown[] = [w.event_id, taskType, 'active', new Date().toISOString()]
    const updates = ['status = EXCLUDED.status', 'next_check = EXCLUDED.next_check']
    if (w.recurrence_months != null) { cols.push('recurrence_months'); vals.push(w.recurrence_months); updates.push('recurrence_months = EXCLUDED.recurrence_months') }
    if (w.last_occurrence_date != null) { cols.push('last_occurrence_date'); vals.push(w.last_occurrence_date); updates.push('last_occurrence_date = EXCLUDED.last_occurrence_date') }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
    const { rows } = await db.query(
      `INSERT INTO plannen.agent_tasks (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (event_id, task_type) DO UPDATE SET ${updates.join(', ')}
       RETURNING *`,
      vals,
    )
    return c.json({ data: rows[0] }, 201)
  })
})

watch.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = PatchWatch.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid patch', JSON.stringify(parsed.error.issues))
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(parsed.data)) {
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No fields')
  return await withUserContext(userId, async (db) => {
    const { rows: ownership } = await db.query(
      `SELECT t.id FROM plannen.agent_tasks t
       JOIN plannen.events e ON e.id = t.event_id
       WHERE t.id = $1 AND e.created_by = $2`,
      [id, userId],
    )
    if (ownership.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Watch task not found')
    params.push(id)
    const { rows } = await db.query(
      `UPDATE plannen.agent_tasks SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length}
       RETURNING *`,
      params,
    )
    return c.json({ data: rows[0] })
  })
})

watch.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      `DELETE FROM plannen.agent_tasks
       WHERE id = $1
         AND event_id IN (SELECT id FROM plannen.events WHERE created_by = $2)`,
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Watch task not found')
    return c.json({ data: { id } })
  })
})
