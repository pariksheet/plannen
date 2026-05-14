import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'events-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('events routes', () => {
  it('POST /api/events creates an event', async () => {
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', start_date: new Date().toISOString() }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.title).toBe('Test')
    expect(body.data.created_by).toBe(testUserId)
  })

  it('GET /api/events returns the created event', async () => {
    const res = await app.request('/api/events?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/events/:id updates', async () => {
    const created = await (await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patchable', start_date: new Date().toISOString() }),
    })).json()
    const id = created.data.id

    const patch = await app.request(`/api/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patched' }),
    })
    expect(patch.status).toBe(200)
    expect((await patch.json()).data.title).toBe('Patched')
  })

  it('DELETE /api/events/:id deletes', async () => {
    const created = await (await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ToDelete', start_date: new Date().toISOString() }),
    })).json()
    const del = await app.request(`/api/events/${created.data.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })
})
