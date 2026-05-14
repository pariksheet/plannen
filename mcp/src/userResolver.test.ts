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
      const { rows } = await c.query(
        `INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [TEST_EMAIL],
      )
      testUserId = rows[0].id
    } finally { c.release() }
  })

  afterAll(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM plannen.users WHERE email = $1', [TEST_EMAIL])
      await c.query('DELETE FROM auth.users WHERE email = $1', [TEST_EMAIL])
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
