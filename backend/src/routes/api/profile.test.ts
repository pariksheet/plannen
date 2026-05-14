import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'profile-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.profile_facts WHERE user_id = $1', [testUserId])
    await c.query('DELETE FROM plannen.user_profiles WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('profile routes', () => {
  it('PATCH /api/profile upserts', async () => {
    const res = await app.request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Europe/Brussels', goals: ['ride'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.timezone).toBe('Europe/Brussels')
  })

  it('GET /api/profile returns the row', async () => {
    const res = await app.request('/api/profile')
    expect(res.status).toBe(200)
    expect((await res.json()).data.user_id).toBe(testUserId)
  })

  let factId: string

  it('POST /api/profile/facts creates a fact', async () => {
    const res = await app.request('/api/profile/facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'me', predicate: 'likes', value: 'pizza' }),
    })
    expect(res.status).toBe(201)
    factId = (await res.json()).data.id
  })

  it('GET /api/profile/facts lists', async () => {
    const res = await app.request('/api/profile/facts')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/profile/facts/:id updates', async () => {
    const res = await app.request(`/api/profile/facts/${factId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sushi' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.value).toBe('sushi')
  })

  it('DELETE /api/profile/facts/:id removes', async () => {
    const res = await app.request(`/api/profile/facts/${factId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
