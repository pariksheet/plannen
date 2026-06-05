// REST surface for plannen.friend_groups + plannen.friend_group_members +
// plannen.event_invites.
//
// Mirrors groupService + inviteService. Group ops scoped to the current user
// as creator. Invites are scoped to events the user created.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const groups = new Hono<{ Variables: AppVariables }>()

const GroupInput = z.object({ name: z.string().min(1) })
const InviteInput = z.object({
  event_id: z.string().uuid(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
})

groups.get('/', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.friend_groups WHERE created_by = $1 ORDER BY name ASC',
      [userId],
    )
    return c.json({ data: rows })
  })
})

groups.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = GroupInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid group', JSON.stringify(parsed.error.issues))
  }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'INSERT INTO plannen.friend_groups (name, created_by) VALUES ($1, $2) RETURNING *',
      [parsed.data.name.trim(), userId],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

groups.get('/invites', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM plannen.event_invites WHERE created_by = $1'
    if (eventId) { params.push(eventId); sql += ` AND event_id = $${params.length}` }
    sql += ' ORDER BY created_at DESC'
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

groups.post('/invites', async (c) => {
  const userId = c.var.userId
  const parsed = InviteInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid invite', JSON.stringify(parsed.error.issues))
  }
  const i = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows: ev } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [i.event_id, userId],
    )
    if (ev.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)),
      (b) => b.toString(16).padStart(2, '0')).join('')
    const days = i.expires_in_days ?? 7
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await db.query(
      `INSERT INTO plannen.event_invites (event_id, token, created_by, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [i.event_id, token, userId, expiresAt],
    )
    return c.json({ data: rows[0] }, 201)
  })
})
