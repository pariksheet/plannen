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

// Web-UI signup / identity-switch on tier 0. Creates the auth.users +
// plannen.users rows if the email is new; resolves the existing rows if not.
// Returns the resolved user the caller should set as the active identity.
//
// Single-user model: switching to a new email leaves the previous user's data
// in place (orphaned). The caller is expected to also rewrite
// PLANNEN_USER_EMAIL in .env so a backend restart sees the new identity.
export async function signupOrSwitch(email: string): Promise<ResolvedUser> {
  if (!email || !email.includes('@')) throw new Error('invalid email')
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    // Idempotent insert into auth.users — mirrors what bootstrap.sh does
    // when it inserts the user row at install time.
    const authRow = await c.query<{ id: string }>(
      `INSERT INTO auth.users (id, email)
       VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email],
    )
    const userId = authRow.rows[0].id
    // plannen.users mirrors auth.users; ensure a row exists.
    await c.query(
      `INSERT INTO plannen.users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [userId, email],
    )
    await c.query('COMMIT')
    return { userId, email }
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
