// REST surface for the wishlist view.
//
// Wishlist is not a separate table — it's a filter over plannen.events
// where event_status ∈ ('watching','missed'). The web wishlistService
// returns the same shape. POST adds an event (sets status=watching);
// DELETE clears the wishlist marker by flipping status back to 'going'.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const wishlist = new Hono<{ Variables: AppVariables }>()

const AddInput = z.object({ event_id: z.string().uuid() })

wishlist.get('/', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM plannen.events
       WHERE created_by = $1 AND event_status = ANY(ARRAY['watching','missed'])
       ORDER BY start_date ASC`,
      [userId],
    )
    return c.json({ data: rows })
  })
})

wishlist.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = AddInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid input', JSON.stringify(parsed.error.issues))
  }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.events SET event_status = 'watching', updated_at = now()
       WHERE id = $1 AND created_by = $2 RETURNING *`,
      [parsed.data.event_id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: rows[0] }, 201)
  })
})

wishlist.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.events SET event_status = 'going', updated_at = now()
       WHERE id = $1 AND created_by = $2 RETURNING id`,
      [id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: { id } })
  })
})
