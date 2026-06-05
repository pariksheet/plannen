// REST surface for plannen.agent_tasks (generic — not just watch tasks).
//
// Mirrors agentTaskService.create*Task: upserts on (event_id, task_type) so
// callers don't have to check existence first. GET lists tasks for events the
// caller owns.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const agentTasks = new Hono<{ Variables: AppVariables }>()

const TaskInput = z.object({
  event_id: z.string().uuid(),
  task_type: z.enum(['enrollment_monitor', 'recurring_check', 'scrape_url']),
  status: z.enum(['pending', 'active', 'completed', 'failed']).optional(),
  next_check: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  recurrence_months: z.number().int().nullable().optional(),
  last_occurrence_date: z.string().nullable().optional(),
})

agentTasks.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  const taskType = c.req.query('task_type')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = `SELECT t.* FROM plannen.agent_tasks t
               JOIN plannen.events e ON e.id = t.event_id
               WHERE e.created_by = $1`
    if (eventId) { params.push(eventId); sql += ` AND t.event_id = $${params.length}` }
    if (taskType) { params.push(taskType); sql += ` AND t.task_type = $${params.length}` }
    params.push(limit)
    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length}`
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

agentTasks.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = TaskInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid task', JSON.stringify(parsed.error.issues))
  }
  const t = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows: ev } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [t.event_id, userId],
    )
    if (ev.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')

    const cols = ['event_id', 'task_type', 'status', 'next_check']
    const vals: unknown[] = [
      t.event_id,
      t.task_type,
      t.status ?? 'active',
      t.next_check ?? new Date().toISOString(),
    ]
    const updates = ['status = EXCLUDED.status', 'next_check = EXCLUDED.next_check']
    if (t.metadata !== undefined) { cols.push('metadata'); vals.push(t.metadata); updates.push('metadata = EXCLUDED.metadata') }
    if (t.recurrence_months !== undefined) { cols.push('recurrence_months'); vals.push(t.recurrence_months); updates.push('recurrence_months = EXCLUDED.recurrence_months') }
    if (t.last_occurrence_date !== undefined) { cols.push('last_occurrence_date'); vals.push(t.last_occurrence_date); updates.push('last_occurrence_date = EXCLUDED.last_occurrence_date') }
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
