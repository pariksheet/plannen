import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
let eventId: string
const testEmail = 'watch-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('W parent', now(), $1, 'watching') RETURNING id`,
      [testUserId],
    )
    eventId = rows[0].id
  } finally { c.release() }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.agent_tasks WHERE event_id = $1', [eventId])
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('watch routes', () => {
  let taskId: string

  it('POST /api/watch creates a watch task', async () => {
    const res = await app.request('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId }),
    })
    expect(res.status).toBe(201)
    taskId = (await res.json()).data.id
  })

  it('GET /api/watch lists', async () => {
    const res = await app.request('/api/watch')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/watch/:id updates', async () => {
    const res = await app.request(`/api/watch/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ has_unread_update: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.has_unread_update).toBe(true)
  })

  it('DELETE /api/watch/:id removes', async () => {
    const res = await app.request(`/api/watch/${taskId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
