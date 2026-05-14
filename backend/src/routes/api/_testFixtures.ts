// Shared test fixtures for /api/* integration tests.
//
// plannen.users.id is FK'd to auth.users.id, so creating a test user means
// inserting a row in auth.users first (provided by the tier-0 compat overlay
// stub or by GoTrue in tier-1) and mirroring into plannen.users.

import type { Pool } from 'pg'

export async function ensureTestUser(pool: Pool, email: string): Promise<string> {
  const c = await pool.connect()
  try {
    const existing = await c.query(
      'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    )
    let userId: string
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id
    } else {
      const inserted = await c.query(
        'INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id',
        [email],
      )
      userId = inserted.rows[0].id
    }
    await c.query(
      `INSERT INTO plannen.users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, email],
    )
    return userId
  } finally {
    c.release()
  }
}

export async function deleteTestUser(pool: Pool, email: string): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.users WHERE email = $1', [email])
    await c.query('DELETE FROM auth.users WHERE email = $1', [email])
  } finally {
    c.release()
  }
}
