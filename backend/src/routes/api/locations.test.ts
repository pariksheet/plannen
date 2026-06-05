import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'locations-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.user_locations WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('locations routes', () => {
  let locId: string

  it('POST /api/locations creates', async () => {
    const res = await app.request('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Home', city: 'Brussels', country: 'BE', is_default: true }),
    })
    expect(res.status).toBe(201)
    locId = (await res.json()).data.id
  })

  it('GET /api/locations lists', async () => {
    const res = await app.request('/api/locations')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/locations/:id updates', async () => {
    const res = await app.request(`/api/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Casa' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.label).toBe('Casa')
  })

  it('DELETE /api/locations/:id removes', async () => {
    const res = await app.request(`/api/locations/${locId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
