// REST surface for plannen.event_sources.
//
// Sources are domain-keyed per-user (unique on user_id+domain). The web app
// touches them indirectly via eventService.upsertEventSource; this endpoint
// exists so the MCP-side discovery flow and any future "manage sources"
// settings page can hit a uniform REST contract.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const sources = new Hono<{ Variables: AppVariables }>()

const SourceInput = z.object({
  domain: z.string().min(1),
  source_url: z.string().min(1),
  name: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  source_type: z.enum(['platform', 'organiser', 'one_off']).optional(),
})

const SourcePatch = z.object({
  name: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  source_type: z.enum(['platform', 'organiser', 'one_off']).optional(),
  last_analysed_at: z.string().datetime().nullable().optional(),
}).strict()

sources.get('/', async (c) => {
  const userId = c.var.userId
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM plannen.event_sources
       WHERE user_id = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [userId, limit],
    )
    return c.json({ data: rows })
  })
})

sources.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = SourceInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid source', JSON.stringify(parsed.error.issues))
  }
  const s = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.event_sources (user_id, domain, source_url, name, tags, source_type)
       VALUES ($1, $2, $3, $4, COALESCE($5,'{}'::text[]), $6)
       ON CONFLICT (user_id, domain) DO UPDATE
         SET source_url = EXCLUDED.source_url,
             name = COALESCE(EXCLUDED.name, plannen.event_sources.name),
             tags = CASE WHEN array_length(EXCLUDED.tags,1) IS NOT NULL THEN EXCLUDED.tags ELSE plannen.event_sources.tags END,
             source_type = COALESCE(EXCLUDED.source_type, plannen.event_sources.source_type),
             updated_at = now()
       RETURNING *`,
      [userId, s.domain, s.source_url, s.name ?? null, s.tags ?? null, s.source_type ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

sources.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = SourcePatch.safeParse(await c.req.json())
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
      `UPDATE plannen.event_sources SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Source not found')
    return c.json({ data: rows[0] })
  })
})
