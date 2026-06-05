import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
let eventId: string
const testEmail = 'agent-tasks-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('AT event', now(), $1, 'going') RETURNING id`,
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

describe('agent-tasks routes', () => {
  it('POST /api/agent-tasks creates a task', async () => {
    const res = await app.request('/api/agent-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, task_type: 'enrollment_monitor' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).data.task_type).toBe('enrollment_monitor')
  })

  it('GET /api/agent-tasks lists', async () => {
    const res = await app.request('/api/agent-tasks')
    expect(res.status).toBe(200)
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1)
  })
})
