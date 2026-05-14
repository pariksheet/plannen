import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'sources-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.event_sources WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('sources routes', () => {
  let sourceId: string

  it('POST /api/sources creates', async () => {
    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com', source_url: 'https://example.com/events', name: 'Example' }),
    })
    expect(res.status).toBe(201)
    sourceId = (await res.json()).data.id
  })

  it('GET /api/sources lists', async () => {
    const res = await app.request('/api/sources')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/sources/:id updates', async () => {
    const res = await app.request(`/api/sources/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.name).toBe('Updated')
  })
})
