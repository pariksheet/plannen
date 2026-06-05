import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from './db.js'
import { resolveUserAtBoot } from './auth.js'

const testEmail = 'auth-test@plannen.local'
let testUserId: string

beforeAll(async () => {
  const c = await pool.connect()
  try {
    // Tier-portable: SELECT first, then INSERT into auth.users only if missing.
    // The handle_new_user trigger creates the matching plannen.users row.
    const existing = await c.query(
      'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
      [testEmail],
    )
    if (existing.rows.length > 0) {
      testUserId = existing.rows[0].id
    } else {
      const inserted = await c.query(
        'INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id',
        [testEmail],
      )
      testUserId = inserted.rows[0].id
    }
  } finally {
    c.release()
  }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail])
    await c.query('DELETE FROM auth.users WHERE email = $1', [testEmail])
  } finally {
    c.release()
  }
})

describe('resolveUserAtBoot', () => {
  it('returns { userId, email } for an existing user', async () => {
    const got = await resolveUserAtBoot(testEmail)
    expect(got).toEqual({ userId: testUserId, email: testEmail })
  })

  it('throws when no user matches', async () => {
    await expect(resolveUserAtBoot('nobody@nowhere.invalid')).rejects.toThrow(
      /no plannen user/i,
    )
  })
})
