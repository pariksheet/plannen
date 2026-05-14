// REST surface for plannen.event_memories.
//
// Memories are scoped by user_id (the uploader) AND filtered through the
// event's created_by to keep results inside the local user's data. List
// supports optional event_id filter; binary upload still goes through the
// /storage/v1/object/event-photos route, this endpoint just stores the row.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const memories = new Hono<{ Variables: AppVariables }>()

const CreateMemory = z.object({
  event_id: z.string().uuid(),
  media_url: z.string().nullable().optional(),
  media_type: z.enum(['image', 'video', 'audio']).optional(),
  caption: z.string().nullable().optional(),
  source: z.enum(['upload', 'google_drive', 'google_photos']).optional(),
  external_id: z.string().nullable().optional(),
  taken_at: z.string().datetime().nullable().optional(),
  transcript: z.string().nullable().optional(),
  transcript_lang: z.string().nullable().optional(),
})

const ALLOWED_UPDATE = ['media_url', 'media_type', 'caption', 'taken_at', 'transcript', 'transcript_lang', 'transcribed_at'] as const

memories.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = `
      SELECT m.* FROM plannen.event_memories m
      JOIN plannen.events e ON e.id = m.event_id
      WHERE e.created_by = $1`
    if (eventId) {
      params.push(eventId)
      sql += ` AND m.event_id = $${params.length}`
    }
    params.push(limit)
    sql += ` ORDER BY m.taken_at DESC NULLS LAST, m.created_at DESC LIMIT $${params.length}`
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

memories.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateMemory.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid memory', JSON.stringify(parsed.error.issues))
  }
  const m = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.event_memories
         (event_id, user_id, media_url, media_type, caption, source, external_id, taken_at, transcript, transcript_lang)
       VALUES ($1,$2,$3,COALESCE($4,'image'),$5,COALESCE($6,'upload'),$7,$8,$9,$10)
       RETURNING *`,
      [m.event_id, userId, m.media_url ?? null, m.media_type ?? null, m.caption ?? null,
        m.source ?? null, m.external_id ?? null, m.taken_at ?? null, m.transcript ?? null, m.transcript_lang ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

memories.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const patch = await c.req.json() as Record<string, unknown>
  const sets: string[] = []
  const params: unknown[] = []
  for (const k of ALLOWED_UPDATE) {
    if (k in patch) {
      params.push(patch[k])
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No allowed fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.event_memories SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Memory not found')
    return c.json({ data: rows[0] })
  })
})

memories.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.event_memories WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Memory not found')
    return c.json({ data: { id } })
  })
})
