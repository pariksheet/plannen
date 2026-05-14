// REST surface for plannen.stories + plannen.story_events.
//
// List embeds linked events (id/title/start_date) matching what the web
// storyService.flattenEvents shape expects. Create accepts an optional
// event_ids array and inserts the join rows in the same transaction.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const stories = new Hono<{ Variables: AppVariables }>()

const CreateStory = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  cover_url: z.string().nullable().optional(),
  user_notes: z.string().nullable().optional(),
  mood: z.string().nullable().optional(),
  tone: z.string().nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
  language: z.string().optional(),
  story_group_id: z.string().uuid().optional(),
  event_ids: z.array(z.string().uuid()).optional(),
})

const ALLOWED_UPDATE = ['title', 'body', 'cover_url', 'user_notes', 'mood', 'tone'] as const

stories.get('/', async (c) => {
  const userId = c.var.userId
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'start_date', e.start_date))
          FROM plannen.story_events se
          JOIN plannen.events e ON e.id = se.event_id
          WHERE se.story_id = s.id), '[]'::jsonb) AS events
       FROM plannen.stories s
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2`,
      [userId, limit],
    )
    return c.json({ data: rows })
  })
})

stories.get('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'start_date', e.start_date))
          FROM plannen.story_events se
          JOIN plannen.events e ON e.id = se.event_id
          WHERE se.story_id = s.id), '[]'::jsonb) AS events
       FROM plannen.stories s
       WHERE s.id = $1 AND s.user_id = $2`,
      [id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Story not found')
    return c.json({ data: rows[0] })
  })
})

stories.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateStory.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid story', JSON.stringify(parsed.error.issues))
  }
  const s = parsed.data
  return await withUserContext(userId, async (db) => {
    const cols = ['user_id', 'title', 'body', 'cover_url', 'user_notes', 'mood', 'tone', 'date_from', 'date_to', 'language']
    const vals: unknown[] = [
      userId, s.title, s.body, s.cover_url ?? null,
      s.user_notes ?? null, s.mood ?? null, s.tone ?? null,
      s.date_from ?? null, s.date_to ?? null, s.language ?? 'en',
    ]
    if (s.story_group_id) { cols.push('story_group_id'); vals.push(s.story_group_id) }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
    const { rows } = await db.query(
      `INSERT INTO plannen.stories (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals,
    )
    const story = rows[0]
    if (s.event_ids?.length) {
      for (const eid of s.event_ids) {
        await db.query(
          'INSERT INTO plannen.story_events (story_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [story.id, eid],
        )
      }
    }
    return c.json({ data: story }, 201)
  })
})

stories.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const patch = await c.req.json() as Record<string, unknown>
  const sets: string[] = []
  const params: unknown[] = []
  for (const k of ALLOWED_UPDATE) {
    if (k in patch) {
      params.push(patch[k])
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No allowed fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.stories SET ${sets.join(', ')}, updated_at = now(), edited_at = now()
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Story not found')
    return c.json({ data: rows[0] })
  })
})

stories.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    await db.query('DELETE FROM plannen.story_events WHERE story_id = $1', [id])
    const { rowCount } = await db.query(
      'DELETE FROM plannen.stories WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Story not found')
    return c.json({ data: { id } })
  })
})
