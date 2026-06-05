// Resolve PLANNEN_USER_EMAIL → user UUID via plannen.users.
// Replaces the supabase-js `auth.admin.listUsers({ email })` call from the
// pre-Tier-0 mcp server.

import { pool } from './db.js'

export async function resolveUserIdByEmail(email: string): Promise<string> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    )
    if (rows.length === 0) {
      throw new Error(
        `No Plannen user found for ${email}. Run scripts/bootstrap.sh or insert a row in plannen.users.`,
      )
    }
    return rows[0].id
  } finally {
    c.release()
  }
}
