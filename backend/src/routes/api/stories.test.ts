import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'stories-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.story_events WHERE story_id IN (SELECT id FROM plannen.stories WHERE user_id = $1)', [testUserId])
    await c.query('DELETE FROM plannen.stories WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('stories routes', () => {
  let storyId: string

  it('POST /api/stories creates a story', async () => {
    const res = await app.request('/api/stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Story', body: 'Body text' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.title).toBe('My Story')
    storyId = body.data.id
  })

  it('GET /api/stories lists', async () => {
    const res = await app.request('/api/stories')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/stories/:id returns one', async () => {
    const res = await app.request(`/api/stories/${storyId}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe(storyId)
  })

  it('PATCH /api/stories/:id updates title', async () => {
    const res = await app.request(`/api/stories/${storyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.title).toBe('Renamed')
  })

  it('DELETE /api/stories/:id removes', async () => {
    const res = await app.request(`/api/stories/${storyId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
