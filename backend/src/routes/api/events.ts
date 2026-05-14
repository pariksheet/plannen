// REST surface for plannen.events. Column names match the actual schema —
// start_date/end_date/enrollment_url/image_url, not the *_ts variants used
// elsewhere. The backend connects as a superuser so RLS does not gate reads;
// every list/get/update/delete scopes to created_by = userId explicitly.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const events = new Hono<{ Variables: AppVariables }>()

const CreateEvent = z.object({
  title: z.string().min(1),
  start_date: z.string().datetime(),
  end_date: z.string().datetime().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  enrollment_url: z.string().nullable().optional(),
  enrollment_deadline: z.string().datetime().nullable().optional(),
  enrollment_start_date: z.string().datetime().nullable().optional(),
  image_url: z.string().nullable().optional(),
  event_kind: z.string().optional(),
  event_type: z.string().optional(),
  event_status: z.string().optional(),
  shared_with_family: z.boolean().optional(),
  shared_with_friends: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  parent_event_id: z.string().uuid().nullable().optional(),
}).passthrough()

const ALLOWED_UPDATE_COLUMNS = [
  'title',
  'description',
  'start_date',
  'end_date',
  'enrollment_url',
  'enrollment_deadline',
  'enrollment_start_date',
  'image_url',
  'location',
  'event_kind',
  'event_type',
  'event_status',
  'shared_with_family',
  'shared_with_friends',
  'hashtags',
  'gcal_event_id',
] as const

events.get('/', async (c) => {
  const userId = c.var.userId
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const fromDate = c.req.query('from_date')
  const toDate = c.req.query('to_date')

  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM plannen.events WHERE created_by = $1'
    if (fromDate) {
      params.push(fromDate)
      sql += ` AND start_date >= $${params.length}`
    }
    if (toDate) {
      params.push(toDate)
      sql += ` AND start_date <= $${params.length}`
    }
    params.push(limit)
    sql += ` ORDER BY start_date ASC LIMIT $${params.length}`
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

events.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateEvent.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid event', JSON.stringify(parsed.error.issues))
  }
  const e = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.events
         (title, description, start_date, end_date, enrollment_url, enrollment_deadline,
          enrollment_start_date, image_url, location, event_kind, event_type, event_status,
          shared_with_family, shared_with_friends, hashtags, parent_event_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               COALESCE($10,'event'), COALESCE($11,'personal'), COALESCE($12,'going'),
               COALESCE($13,false), COALESCE($14,'none'), COALESCE($15,'{}'::text[]),
               $16, $17)
       RETURNING *`,
      [
        e.title,
        e.description ?? null,
        e.start_date,
        e.end_date ?? null,
        e.enrollment_url ?? null,
        e.enrollment_deadline ?? null,
        e.enrollment_start_date ?? null,
        e.image_url ?? null,
        e.location ?? null,
        e.event_kind ?? null,
        e.event_type ?? null,
        e.event_status ?? null,
        e.shared_with_family ?? null,
        e.shared_with_friends ?? null,
        e.hashtags ?? null,
        e.parent_event_id ?? null,
        userId,
      ],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

events.get('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.events WHERE id = $1 AND created_by = $2',
      [id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: rows[0] })
  })
})

events.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const patch = await c.req.json() as Record<string, unknown>
  const sets: string[] = []
  const params: unknown[] = []
  for (const k of ALLOWED_UPDATE_COLUMNS) {
    if (k in patch) {
      params.push(patch[k])
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No allowed fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.events SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND created_by = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: rows[0] })
  })
})

events.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.events WHERE id = $1 AND created_by = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: { id } })
  })
})
