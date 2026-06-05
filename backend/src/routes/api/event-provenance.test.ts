import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'event-provenance-test@plannen.local'

async function makeEvent(): Promise<string> {
  // Specify event_status explicitly — the column's default ("upcoming") is not
  // in the events_event_status_check constraint, which would fail the insert.
  const { rows } = await pool.query(
    `INSERT INTO plannen.events (created_by, title, start_date, event_status) VALUES ($1, 'provenance test', now(), 'going') RETURNING id`,
    [testUserId],
  )
  return rows[0].id as string
}

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

beforeEach(async () => {
  await pool.query('DELETE FROM plannen.events WHERE created_by = $1 AND title = $2', [testUserId, 'provenance test'])
})

describe('event-provenance routes', () => {
  it('GET returns null when no provenance row exists', async () => {
    const eventId = await makeEvent()
    const res = await app.request(`/api/event-provenance?event_id=${eventId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown }).data).toBeNull()
  })

  it('GET requires event_id', async () => {
    const res = await app.request('/api/event-provenance')
    expect(res.status).toBe(400)
  })

  it('POST creates a row and GET returns it', async () => {
    const eventId = await makeEvent()
    const post = await app.request('/api/event-provenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId, source: 'mailbox', adapter_id: 'gmail',
        sender_email: 'a@b.com', sender_domain: 'b.com', subject: 'hi',
      }),
    })
    expect(post.status).toBe(201)
    const get = await app.request(`/api/event-provenance?event_id=${eventId}`)
    const data = ((await get.json()) as { data: { source: string; sender_email: string } | null }).data
    expect(data?.source).toBe('mailbox')
    expect(data?.sender_email).toBe('a@b.com')
  })

  it('POST upserts on conflict', async () => {
    const eventId = await makeEvent()
    const body = { event_id: eventId, source: 'mailbox', sender_email: 'a@b.com' }
    await app.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const second = await app.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, sender_email: 'c@d.com' }),
    })
    expect(second.status).toBe(201)
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM plannen.event_provenance WHERE event_id = $1', [eventId])
    expect(rows[0].c).toBe(1)
    const get = await app.request(`/api/event-provenance?event_id=${eventId}`)
    const data = ((await get.json()) as { data: { sender_email: string } }).data
    expect(data.sender_email).toBe('c@d.com')
  })

  it('POST 404s when the event is not owned by the user', async () => {
    const res = await app.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: '00000000-0000-0000-0000-000000000000', source: 'mailbox' }),
    })
    expect(res.status).toBe(404)
  })
})
