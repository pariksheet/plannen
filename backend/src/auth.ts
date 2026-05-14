// Resolve the local Plannen user at boot. The backend is single-user
// (Tier 0) — `PLANNEN_USER_EMAIL` from .env identifies which row in
// `plannen.users` to bind every request to. Tier 1 still issues per-request
// JWTs; this helper is unused there.

import { pool } from './db.js'

export type ResolvedUser = { userId: string; email: string }

export async function resolveUserAtBoot(email: string): Promise<ResolvedUser> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      'SELECT id, email FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    )
    if (rows.length === 0) {
      throw new Error(
        `No Plannen user for ${email}. Run scripts/bootstrap.sh or insert a plannen.users row.`,
      )
    }
    return { userId: rows[0].id, email: rows[0].email }
  } finally {
    c.release()
  }
}
