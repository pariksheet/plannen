import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'rels-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.family_members WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('relationships routes', () => {
  let memberId: string

  it('POST /api/relationships/family-members creates', async () => {
    const res = await app.request('/api/relationships/family-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', relation: 'sibling' }),
    })
    expect(res.status).toBe(201)
    memberId = (await res.json()).data.id
  })

  it('GET /api/relationships/family-members lists', async () => {
    const res = await app.request('/api/relationships/family-members')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/relationships/family-members/:id updates', async () => {
    const res = await app.request(`/api/relationships/family-members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Samuel' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.name).toBe('Samuel')
  })

  it('DELETE /api/relationships/family-members/:id removes', async () => {
    const res = await app.request(`/api/relationships/family-members/${memberId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('GET /api/relationships/relationships returns list', async () => {
    const res = await app.request('/api/relationships/relationships')
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).data)).toBe(true)
  })
})
