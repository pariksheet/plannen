// REST surface for plannen.family_members + plannen.relationships.
//
// family_members are owned per-user (CRUD). relationships are read-only
// here — the web app's accept/decline flow uses RPCs that are not part of
// the v0 backend; only the listing call ships now.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const relationships = new Hono<{ Variables: AppVariables }>()

const FamilyMemberInput = z.object({
  name: z.string().min(1),
  relation: z.string().min(1),
  dob: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  goals: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
})

const FamilyMemberPatch = FamilyMemberInput.partial()

relationships.get('/family-members', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    )
    return c.json({ data: rows })
  })
})

relationships.post('/family-members', async (c) => {
  const userId = c.var.userId
  const parsed = FamilyMemberInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid family member', JSON.stringify(parsed.error.issues))
  }
  const m = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.family_members (user_id, name, relation, dob, gender, goals, interests)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}'::text[]),COALESCE($7,'{}'::text[]))
       RETURNING *`,
      [userId, m.name, m.relation, m.dob ?? null, m.gender ?? null, m.goals ?? null, m.interests ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

relationships.patch('/family-members/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = FamilyMemberPatch.safeParse(await c.req.json())
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
    const { rows } = await db.query(
      `UPDATE plannen.family_members SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Family member not found')
    return c.json({ data: rows[0] })
  })
})

relationships.delete('/family-members/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.family_members WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Family member not found')
    return c.json({ data: { id } })
  })
})

relationships.get('/relationships', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM plannen.relationships
       WHERE user_id = $1 OR related_user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    )
    return c.json({ data: rows })
  })
})
