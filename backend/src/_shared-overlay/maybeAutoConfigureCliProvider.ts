// Idempotent first-boot helper: writes a `claude-code-cli` provider row when
// the user has no existing settings. Existing rows are left alone so a user
// who already configured BYOK is never auto-overridden.

import type { Pool } from 'pg'

export async function maybeAutoConfigureCliProvider(
  pool: Pool,
  userId: string,
  version: string | null,
): Promise<void> {
  const existing = await pool.query(
    'SELECT user_id FROM plannen.user_settings WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId],
  )
  if (existing.rows.length > 0) return

  await pool.query(
    `INSERT INTO plannen.user_settings (user_id, provider, is_default, default_model, api_key, base_url)
     VALUES ($1, 'claude-code-cli', true, NULL, NULL, NULL)`,
    [userId],
  )
  // eslint-disable-next-line no-console
  console.log(`detected Claude CLI ${version ?? '(unknown version)'} — using your subscription for AI calls`)
}
