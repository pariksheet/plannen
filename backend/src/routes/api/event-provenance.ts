// REST surface for plannen.event_provenance (Tier 0).
// GET by event_id (returns row or null); POST upserts; visibility scoped to
// events the current user created.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const eventProvenance = new Hono<{ Variables: AppVariables }>()

const ProvenanceInput = z.object({
  event_id: z.string().uuid(),
  source: z.string().min(1),
  adapter_id: z.string().optional().nullable(),
  source_message_id: z.string().optional().nullable(),
  sender_display: z.string().optional().nullable(),
  sender_email: z.string().optional().nullable(),
  sender_domain: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
})

eventProvenance.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  if (!eventId) throw new HttpError(400, 'VALIDATION', 'event_id is required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT p.* FROM plannen.event_provenance p
         JOIN plannen.events e ON e.id = p.event_id
        WHERE p.event_id = $1 AND e.created_by = $2`,
      [eventId, userId],
    )
    return c.json({ data: rows[0] ?? null })
  })
})

eventProvenance.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = ProvenanceInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid provenance', JSON.stringify(parsed.error.issues))
  }
  const v = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows: er } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [v.event_id, userId],
    )
    if (er.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    const { rows } = await db.query(
      `INSERT INTO plannen.event_provenance
         (event_id, source, adapter_id, source_message_id, sender_display, sender_email, sender_domain, subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO UPDATE SET
         source = EXCLUDED.source,
         adapter_id = EXCLUDED.adapter_id,
         source_message_id = EXCLUDED.source_message_id,
         sender_display = EXCLUDED.sender_display,
         sender_email = EXCLUDED.sender_email,
         sender_domain = EXCLUDED.sender_domain,
         subject = EXCLUDED.subject
       RETURNING *`,
      [v.event_id, v.source, v.adapter_id ?? null, v.source_message_id ?? null, v.sender_display ?? null, v.sender_email ?? null, v.sender_domain ?? null, v.subject ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})
