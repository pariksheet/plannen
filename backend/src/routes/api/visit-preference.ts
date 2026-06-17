// REST surface for plannen.event_visit_preferences.
//
// A visit-date planning hint, decoupled from RSVP status (issue #5). Setting a
// visit date here never creates or mutates an RSVP. Single POST upserts on
// (event_id, user_id); GET fetches the caller's hint for an event, or a batch
// across many events.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const visitPreference = new Hono<{ Variables: AppVariables }>()

const VisitPreferenceInput = z.object({
  event_id: z.string().uuid(),
  visit_date: z.string().nullable().optional(),
})

visitPreference.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  const eventIds = c.req.query('event_ids')
  if (eventIds) {
    // Batch lookup: comma-separated event_ids → all visit prefs (any user) for
    // those events the caller has access to. Mirrors the rsvp batch endpoint.
    const ids = eventIds.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return c.json({ data: [] })
    if (ids.length > 1000) throw new HttpError(400, 'VALIDATION', 'event_ids too long')
    return await withUserContext(userId, async (db) => {
      const { rows } = await db.query(
        'SELECT * FROM plannen.event_visit_preferences WHERE event_id = ANY($1::uuid[])',
        [ids],
      )
      return c.json({ data: rows })
    })
  }
  if (!eventId) throw new HttpError(400, 'VALIDATION', 'event_id or event_ids is required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.event_visit_preferences WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    )
    return c.json({ data: rows[0] ?? null })
  })
})

visitPreference.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = VisitPreferenceInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid visit preference', JSON.stringify(parsed.error.issues))
  }
  const r = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.event_visit_preferences (event_id, user_id, visit_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, user_id) DO UPDATE
         SET visit_date = EXCLUDED.visit_date,
             updated_at = now()
       RETURNING *`,
      [r.event_id, userId, r.visit_date ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})
