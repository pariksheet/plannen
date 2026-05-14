import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'me-test@plannen.local'

beforeAll(async () => {
  const c = await pool.connect()
  try {
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
  app = buildApp({ userId: testUserId, userEmail: testEmail })
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

describe('GET /api/me', () => {
  it('returns the resolved user', async () => {
    const res = await app.request('/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { userId: testUserId, email: testEmail, full_name: null, avatar_url: null },
    })
  })
})
