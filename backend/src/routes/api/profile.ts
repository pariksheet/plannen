// REST surface for plannen.user_profiles + plannen.profile_facts.
//
// Single-row profile keyed by user_id. PATCH upserts. Facts are CRUD'd
// under /facts so the web app's MCP-style "list_profile_facts" path has a
// matching REST shape.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const profile = new Hono<{ Variables: AppVariables }>()

// full_name + avatar_url live on plannen.users (the auth-linked row), the rest
// live on plannen.user_profiles. PATCH dispatches each field to its table.
const USERS_COLS = new Set(['full_name', 'avatar_url'])
const PROFILE_COLS = new Set(['dob', 'goals', 'interests', 'timezone', 'story_languages'])

const ProfilePatch = z.object({
  full_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  dob: z.string().nullable().optional(),
  goals: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  story_languages: z.array(z.string()).optional(),
}).strict()

const FactInput = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(['agent_inferred', 'user_stated']).optional(),
  is_historical: z.boolean().optional(),
})

const FactPatch = z.object({
  value: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  is_historical: z.boolean().optional(),
}).strict()

profile.get('/', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.user_profiles WHERE user_id = $1',
      [userId],
    )
    return c.json({ data: rows[0] ?? null })
  })
})

profile.patch('/', async (c) => {
  const userId = c.var.userId
  const parsed = ProfilePatch.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid profile', JSON.stringify(parsed.error.issues))
  }
  const p = parsed.data
  const userFields: Record<string, unknown> = {}
  const profileFields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (USERS_COLS.has(k)) userFields[k] = v
    else if (PROFILE_COLS.has(k)) profileFields[k] = v
  }
  return await withUserContext(userId, async (db) => {
    // 1. Update plannen.users for full_name / avatar_url (if present).
    if (Object.keys(userFields).length > 0) {
      const sets: string[] = []
      const vals: unknown[] = []
      for (const [k, v] of Object.entries(userFields)) {
        vals.push(v)
        sets.push(`${k} = $${vals.length}`)
      }
      vals.push(userId)
      await db.query(
        `UPDATE plannen.users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`,
        vals,
      )
    }
    // 2. Upsert plannen.user_profiles for the rest (if present).
    let profileRow: unknown = null
    if (Object.keys(profileFields).length > 0) {
      const cols = ['user_id']
      const vals: unknown[] = [userId]
      const updates: string[] = []
      for (const [k, v] of Object.entries(profileFields)) {
        cols.push(k)
        vals.push(v)
        updates.push(`${k} = EXCLUDED.${k}`)
      }
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
      const onConflict = `ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`
      const { rows } = await db.query(
        `INSERT INTO plannen.user_profiles (${cols.join(', ')}) VALUES (${placeholders})
         ${onConflict}
         RETURNING *`,
        vals,
      )
      profileRow = rows[0]
    } else {
      const { rows } = await db.query(
        'SELECT * FROM plannen.user_profiles WHERE user_id = $1',
        [userId],
      )
      profileRow = rows[0] ?? null
    }
    return c.json({ data: profileRow })
  })
})

// ─── facts ────────────────────────────────────────────────────────────────────

profile.get('/facts', async (c) => {
  const userId = c.var.userId
  const subject = c.req.query('subject')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM plannen.profile_facts WHERE user_id = $1'
    if (subject) {
      params.push(subject)
      sql += ` AND subject = $${params.length}`
    }
    params.push(limit)
    sql += ` ORDER BY last_seen_at DESC LIMIT $${params.length}`
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

profile.post('/facts', async (c) => {
  const userId = c.var.userId
  const parsed = FactInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid fact', JSON.stringify(parsed.error.issues))
  }
  const f = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.profile_facts (user_id, subject, predicate, value, confidence, source, is_historical)
       VALUES ($1,$2,$3,$4,COALESCE($5,0.7),COALESCE($6,'user_stated'),COALESCE($7,false))
       RETURNING *`,
      [userId, f.subject, f.predicate, f.value, f.confidence ?? null, f.source ?? null, f.is_historical ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

profile.patch('/facts/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = FactPatch.safeParse(await c.req.json())
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
      `UPDATE plannen.profile_facts SET ${sets.join(', ')}, last_seen_at = now()
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Fact not found')
    return c.json({ data: rows[0] })
  })
})

profile.delete('/facts/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.profile_facts WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Fact not found')
    return c.json({ data: { id } })
  })
})
