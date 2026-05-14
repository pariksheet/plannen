// REST surface for plannen.user_settings (BYOK AI provider settings).
//
// GET returns the default provider row with api_key REDACTED to a boolean
// marker — the plaintext key never leaves the DB. PATCH upserts a row keyed
// on (user_id, provider). DELETE removes the configured provider.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const settings = new Hono<{ Variables: AppVariables }>()

const SettingsInput = z.object({
  provider: z.string().min(1),
  api_key: z.string().nullable().optional(),
  base_url: z.string().nullable().optional(),
  default_model: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
})

function redact(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null
  const { api_key, ...rest } = row
  return { ...rest, has_api_key: Boolean(api_key) }
}

settings.get('/', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM plannen.user_settings
       WHERE user_id = $1
       ORDER BY is_default DESC, last_used_at DESC NULLS LAST
       LIMIT 1`,
      [userId],
    )
    return c.json({ data: redact(rows[0]) })
  })
})

settings.patch('/', async (c) => {
  const userId = c.var.userId
  const parsed = SettingsInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid settings', JSON.stringify(parsed.error.issues))
  }
  const s = parsed.data
  return await withUserContext(userId, async (db) => {
    if (s.is_default) {
      await db.query('UPDATE plannen.user_settings SET is_default = false WHERE user_id = $1', [userId])
    }
    const { rows } = await db.query(
      `INSERT INTO plannen.user_settings (user_id, provider, api_key, base_url, default_model, is_default)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
       ON CONFLICT (user_id, provider) DO UPDATE
         SET api_key = COALESCE(EXCLUDED.api_key, plannen.user_settings.api_key),
             base_url = EXCLUDED.base_url,
             default_model = EXCLUDED.default_model,
             is_default = EXCLUDED.is_default,
             updated_at = now()
       RETURNING *`,
      [userId, s.provider, s.api_key ?? null, s.base_url ?? null, s.default_model ?? null, s.is_default ?? null],
    )
    return c.json({ data: redact(rows[0]) })
  })
})

settings.delete('/', async (c) => {
  const userId = c.var.userId
  const provider = c.req.query('provider')
  return await withUserContext(userId, async (db) => {
    if (provider) {
      await db.query('DELETE FROM plannen.user_settings WHERE user_id = $1 AND provider = $2', [userId, provider])
    } else {
      await db.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [userId])
    }
    return c.json({ data: { ok: true } })
  })
})
