import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'practices-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query(
      `DELETE FROM plannen.practice_completions
       WHERE practice_id IN (
         SELECT id FROM plannen.practices WHERE user_id = $1
       )`,
      [testUserId],
    )
    await c.query('DELETE FROM plannen.practices WHERE user_id = $1', [testUserId])
  } finally {
    c.release()
  }
  await deleteTestUser(pool, testEmail)
})

describe('practices REST', () => {
  it('POST /api/practices creates a practice', async () => {
    const res = await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gym',
        category: 'health',
        recurrence_mode: 'flex_count',
        flex_period: 'week',
        flex_target: 3,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      data: { id: string; name: string; recurrence_mode: string; flex_period: string; flex_target: number }
    }
    expect(body.data.name).toBe('Gym')
    expect(body.data.recurrence_mode).toBe('flex_count')
    expect(body.data.flex_period).toBe('week')
    expect(body.data.flex_target).toBe(3)
  })

  it('GET /api/practices lists practices', async () => {
    await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Vitamin D',
        category: 'health',
        recurrence_mode: 'pinned',
        recurrence_rule: { frequency: 'daily' },
      }),
    })
    const res = await app.request('/api/practices')
    const body = (await res.json()) as { data: Array<{ name: string }> }
    expect(body.data.map((p) => p.name)).toContain('Vitamin D')
  })

  it('GET /api/practices/completions returns completions since date', async () => {
    const created = await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gym',
        category: 'health',
        recurrence_mode: 'pinned',
        recurrence_rule: { frequency: 'daily' },
      }),
    })
    const { data } = (await created.json()) as { data: { id: string } }

    await app.request(`/api/practices/${data.id}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed_on: '2026-05-18' }),
    })

    const res = await app.request('/api/practices/completions?since=2026-05-18')
    const body = (await res.json()) as { data: Array<{ practice_id: string; completed_on: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].completed_on).toBe('2026-05-18')
  })

  it('POST /api/practices/:id/completions records a completion', async () => {
    const created = await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gym',
        category: 'health',
        recurrence_mode: 'pinned',
        recurrence_rule: { frequency: 'daily' },
      }),
    })
    const { data } = (await created.json()) as { data: { id: string } }

    const res = await app.request(`/api/practices/${data.id}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed_on: '2026-05-20' }),
    })
    expect(res.status).toBe(201)

    // idempotent — second insert same date should still return 201
    const res2 = await app.request(`/api/practices/${data.id}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed_on: '2026-05-20' }),
    })
    expect(res2.status).toBe(201)
  })
})
