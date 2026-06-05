import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const briefings = new Hono<{ Variables: AppVariables }>()

const BriefingInput = z.object({
  briefing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content_md: z.string().min(1),
  summary: z.string().nullable().optional(),
  source: z.enum(['claude_code', 'claude_desktop', 'web', 'cron']),
})

briefings.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = BriefingInput.safeParse(await c.req.json())
  if (!parsed.success)
    throw new HttpError(400, 'VALIDATION', 'Invalid briefing', JSON.stringify(parsed.error.issues))
  const b = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.daily_briefings
         (user_id, briefing_date, content_md, summary, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, briefing_date) DO UPDATE
         SET content_md = EXCLUDED.content_md,
             summary = EXCLUDED.summary,
             source = EXCLUDED.source,
             generated_at = now()
       RETURNING *`,
      [userId, b.briefing_date, b.content_md, b.summary ?? null, b.source],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

briefings.get('/:date', async (c) => {
  const userId = c.var.userId
  const date = c.req.param('date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new HttpError(400, 'VALIDATION', 'date must be YYYY-MM-DD')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT id, briefing_date::text, content_md, summary, source, generated_at
       FROM plannen.daily_briefings
       WHERE user_id = $1 AND briefing_date = $2::date`,
      [userId, date],
    )
    return c.json({ data: rows[0] ?? null })
  })
})
