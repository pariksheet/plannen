import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from './db.js'
import { resolveUserIdByEmail } from './userResolver.js'

const TEST_EMAIL = 'resolver-test@plannen.local'
let testUserId: string

describe('resolveUserIdByEmail', () => {
  beforeAll(async () => {
    const c = await pool.connect()
    try {
      // plannen.users.id FKs to auth.users.id. Insert into auth.users; the
      // handle_new_user trigger populates plannen.users automatically.
      // Real Supabase auth.users.email has no UNIQUE constraint, so we
      // SELECT-then-INSERT instead of ON CONFLICT (email).
      const existing = await c.query(
        'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
        [TEST_EMAIL],
      )
      if (existing.rows.length > 0) {
        testUserId = existing.rows[0].id
      } else {
        const { rows } = await c.query(
          'INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id',
          [TEST_EMAIL],
        )
        testUserId = rows[0].id
      }
    } finally { c.release() }
  })

  afterAll(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM plannen.users WHERE id = $1', [testUserId])
      await c.query('DELETE FROM auth.users WHERE id = $1', [testUserId])
    } finally { c.release() }
  })

  it('returns the uuid for an existing user (case-insensitive)', async () => {
    const id = await resolveUserIdByEmail('RESOLVER-TEST@plannen.local')
    expect(id).toBe(testUserId)
  })

  it('throws when no row exists', async () => {
    await expect(resolveUserIdByEmail('nobody@nowhere.invalid')).rejects.toThrow(/no plannen user/i)
  })
})
