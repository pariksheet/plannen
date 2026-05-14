import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
let eventId: string
const testEmail = 'rsvp-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('Rsvp parent', now(), $1, 'going') RETURNING id`,
      [testUserId],
    )
    eventId = rows[0].id
  } finally { c.release() }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.event_rsvps WHERE user_id = $1', [testUserId])
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('rsvp routes', () => {
  it('POST /api/rsvp upserts a status', async () => {
    const res = await app.request('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, status: 'going' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).data.status).toBe('going')
  })

  it('POST /api/rsvp updates existing', async () => {
    const res = await app.request('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, status: 'maybe' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).data.status).toBe('maybe')
  })

  it('GET /api/rsvp?event_id returns my rsvp', async () => {
    const res = await app.request(`/api/rsvp?event_id=${eventId}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('maybe')
  })
})
