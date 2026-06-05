import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
let eventId: string
const testEmail = 'groups-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('Group event', now(), $1, 'going') RETURNING id`,
      [testUserId],
    )
    eventId = rows[0].id
  } finally { c.release() }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.event_invites WHERE created_by = $1', [testUserId])
    await c.query('DELETE FROM plannen.friend_groups WHERE created_by = $1', [testUserId])
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('groups routes', () => {
  it('POST /api/groups creates a group', async () => {
    const res = await app.request('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cousins' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).data.name).toBe('Cousins')
  })

  it('GET /api/groups lists', async () => {
    const res = await app.request('/api/groups')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/groups/invites creates an invite', async () => {
    const res = await app.request('/api/groups/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).data.token).toMatch(/^[a-f0-9]{48}$/)
  })

  it('GET /api/groups/invites lists', async () => {
    const res = await app.request('/api/groups/invites')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })
})
