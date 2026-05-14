import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
let eventId: string
const testEmail = 'memories-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })

  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('Memory parent', now(), $1, 'going') RETURNING id`,
      [testUserId],
    )
    eventId = rows[0].id
  } finally { c.release() }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.event_memories WHERE user_id = $1', [testUserId])
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('memories routes', () => {
  let memId: string

  it('POST /api/memories creates a memory', async () => {
    const res = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, caption: 'hello', media_url: 'https://x/y.jpg' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.caption).toBe('hello')
    memId = body.data.id
  })

  it('GET /api/memories?event_id filters', async () => {
    const res = await app.request(`/api/memories?event_id=${eventId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/memories/:id updates caption', async () => {
    const res = await app.request(`/api/memories/${memId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: 'updated' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.caption).toBe('updated')
  })

  it('DELETE /api/memories/:id removes', async () => {
    const res = await app.request(`/api/memories/${memId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
