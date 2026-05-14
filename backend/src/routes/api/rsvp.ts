// REST surface for plannen.event_rsvps.
//
// Single POST endpoint that upserts on (event_id, user_id). GET fetches the
// current user's RSVP for a specific event. Delete is intentionally absent —
// the rsvpService model upserts a row with status; "clear" is just another
// status value.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const rsvp = new Hono<{ Variables: AppVariables }>()

const RsvpInput = z.object({
  event_id: z.string().uuid(),
  status: z.enum(['going', 'maybe', 'not_going']),
  preferred_visit_date: z.string().nullable().optional(),
})

rsvp.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  if (!eventId) throw new HttpError(400, 'VALIDATION', 'event_id is required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.event_rsvps WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    )
    return c.json({ data: rows[0] ?? null })
  })
})

rsvp.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = RsvpInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid rsvp', JSON.stringify(parsed.error.issues))
  }
  const r = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.event_rsvps (event_id, user_id, status, preferred_visit_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, user_id) DO UPDATE
         SET status = EXCLUDED.status,
             preferred_visit_date = EXCLUDED.preferred_visit_date,
             updated_at = now()
       RETURNING *`,
      [r.event_id, userId, r.status, r.preferred_visit_date ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})
