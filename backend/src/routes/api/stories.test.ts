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

  it('GET /api/stories?story_group_id=... filters to the group', async () => {
    const groupId = '11111111-1111-1111-1111-111111111111'
    const otherId = '22222222-2222-2222-2222-222222222222'
    const mk = (title: string, gid: string | null) =>
      app.request('/api/stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: 'b', ...(gid ? { story_group_id: gid } : {}) }),
      })
    await mk('group A 1', groupId)
    await mk('group A 2', groupId)
    await mk('group B', otherId)
    const res = await app.request(`/api/stories?story_group_id=${groupId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBe(2)
    for (const row of body.data) expect(row.story_group_id).toBe(groupId)
  })

  it('DELETE /api/stories/:id removes', async () => {
    const res = await app.request(`/api/stories/${storyId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
