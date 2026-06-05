// REST surface for plannen.user_locations.
//
// CRUD scoped by user_id. is_default is mutually exclusive — setting one
// clears the others in the same transaction so the web app's UI invariant
// holds.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const locations = new Hono<{ Variables: AppVariables }>()

const LocationInput = z.object({
  label: z.string().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  is_default: z.boolean().optional(),
})

const LocationPatch = LocationInput.partial()

locations.get('/', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.user_locations WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    )
    return c.json({ data: rows })
  })
})

locations.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = LocationInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid location', JSON.stringify(parsed.error.issues))
  }
  const l = parsed.data
  return await withUserContext(userId, async (db) => {
    if (l.is_default) {
      await db.query('UPDATE plannen.user_locations SET is_default = false WHERE user_id = $1', [userId])
    }
    const { rows } = await db.query(
      `INSERT INTO plannen.user_locations (user_id, label, address, city, country, is_default)
       VALUES ($1, $2, COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), COALESCE($6,false))
       RETURNING *`,
      [userId, l.label, l.address ?? null, l.city ?? null, l.country ?? null, l.is_default ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

locations.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = LocationPatch.safeParse(await c.req.json())
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
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    if (parsed.data.is_default) {
      await db.query(
        'UPDATE plannen.user_locations SET is_default = false WHERE user_id = $1 AND id <> $2',
        [userId, id],
      )
    }
    const { rows } = await db.query(
      `UPDATE plannen.user_locations SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Location not found')
    return c.json({ data: rows[0] })
  })
})

locations.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.user_locations WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Location not found')
    return c.json({ data: { id } })
  })
})
