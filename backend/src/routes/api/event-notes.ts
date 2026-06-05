// REST surface for plannen.event_notes (Tier-0 single-user mode).
//
// In Tier 0 there's no RLS and only one logged-in user. Routes scope by
// user_id for INSERT/UPDATE/DELETE; SELECT joins through events.created_by =
// current user to keep results inside the local user's data.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const eventNotes = new Hono<{ Variables: AppVariables }>()

const CreateNote = z.object({
  event_id: z.string().uuid(),
  body: z.string().min(1),
})

const UpdateNote = z.object({
  body: z.string().min(1),
})

eventNotes.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  if (!eventId) {
    throw new HttpError(400, 'VALIDATION', 'event_id is required')
  }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT n.id, n.event_id, n.user_id, n.body, n.created_at, n.updated_at,
              jsonb_build_object('full_name', u.full_name, 'email', u.email) AS author
         FROM plannen.event_notes n
         JOIN plannen.events e ON e.id = n.event_id
         JOIN plannen.users u ON u.id = n.user_id
        WHERE e.created_by = $1 AND n.event_id = $2
        ORDER BY n.created_at DESC`,
      [userId, eventId],
    )
    return c.json({ data: rows })
  })
})

eventNotes.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateNote.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid note', JSON.stringify(parsed.error.issues))
  }
  const { event_id, body } = parsed.data
  const trimmed = body.trim()
  if (!trimmed) throw new HttpError(400, 'VALIDATION', 'Note body is required')
  return await withUserContext(userId, async (db) => {
    const { rows: eventRows } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [event_id, userId],
    )
    if (eventRows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    const { rows } = await db.query(
      `INSERT INTO plannen.event_notes (event_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, event_id, user_id, body, created_at, updated_at`,
      [event_id, userId, trimmed],
    )
    const inserted = rows[0] as Record<string, unknown>
    const { rows: userRows } = await db.query(
      'SELECT full_name, email FROM plannen.users WHERE id = $1',
      [userId],
    )
    inserted.author = userRows[0] ?? null
    return c.json({ data: inserted }, 201)
  })
})

eventNotes.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = UpdateNote.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid update', JSON.stringify(parsed.error.issues))
  }
  const trimmed = parsed.data.body.trim()
  if (!trimmed) throw new HttpError(400, 'VALIDATION', 'Note body is required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.event_notes SET body = $1
         WHERE id = $2 AND user_id = $3
       RETURNING id, event_id, user_id, body, created_at, updated_at`,
      [trimmed, id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Note not found')
    const updated = rows[0] as Record<string, unknown>
    const { rows: userRows } = await db.query(
      'SELECT full_name, email FROM plannen.users WHERE id = $1',
      [userId],
    )
    updated.author = userRows[0] ?? null
    return c.json({ data: updated })
  })
})

eventNotes.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.event_notes WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Note not found')
    return c.json({ data: { id } })
  })
})
