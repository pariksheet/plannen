import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'briefings-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.daily_briefings WHERE user_id = $1', [testUserId])
  } finally {
    c.release()
  }
  await deleteTestUser(pool, testEmail)
})

describe('briefings REST', () => {
  it('POST /api/briefings upserts a briefing', async () => {
    const res = await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        briefing_date: '2026-05-20',
        content_md: '# Tuesday\n\n## Schedule\n- 08:00 — Vitamin D',
        source: 'web',
      }),
    })
    expect(res.status).toBe(201)

    // Second save overwrites.
    const res2 = await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        briefing_date: '2026-05-20',
        content_md: '# Tuesday\n\n## Schedule\n- 09:00 — Standup',
        source: 'web',
      }),
    })
    expect(res2.status).toBe(201)
  })

  it('GET /api/briefings/:date returns latest', async () => {
    await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ briefing_date: '2026-05-21', content_md: 'hi', source: 'web' }),
    })
    const res = await app.request('/api/briefings/2026-05-21')
    const body = (await res.json()) as { data: { content_md: string } | null }
    expect(body.data?.content_md).toBe('hi')
  })

  it('GET /api/briefings/:date returns null when missing', async () => {
    const res = await app.request('/api/briefings/2026-01-01')
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toBeNull()
  })
})
