import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import webpush from 'web-push'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

const vapid = webpush.generateVAPIDKeys()

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'push-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  await deleteTestUser(pool, testEmail)
})

afterEach(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.push_subscriptions WHERE user_id = $1', [testUserId])
  } finally { c.release() }
})

const validBody = JSON.stringify({
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256-test', auth: 'auth-test' },
  userAgent: 'vitest',
})

describe('GET /api/push/vapid-public-key', () => {
  it('returns the key when configured', async () => {
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey
    const local = buildApp({ userId: testUserId, userEmail: testEmail })
    const res = await local.request('/api/push/vapid-public-key')
    expect(res.status).toBe(200)
    const body = await res.json() as { key: string | null }
    expect(body.key).toBe(vapid.publicKey)
    delete process.env.VAPID_PUBLIC_KEY
  })
})

describe('POST /api/push/subscribe', () => {
  it('stores a subscription', async () => {
    const res = await app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(201)
    const c = await pool.connect()
    try {
      const { rows } = await c.query(
        'SELECT endpoint, user_agent FROM plannen.push_subscriptions WHERE user_id = $1',
        [testUserId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].endpoint).toBe('https://push.example/abc')
      expect(rows[0].user_agent).toBe('vitest')
    } finally { c.release() }
  })

  it('upserts on duplicate endpoint for same user', async () => {
    await app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })
    const res = await app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(201)
    const c = await pool.connect()
    try {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM plannen.push_subscriptions WHERE user_id = $1',
        [testUserId],
      )
      expect(rows[0].n).toBe(1)
    } finally { c.release() }
  })

  it('rejects malformed bodies', async () => {
    const res = await app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'not-a-url' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/push/subscribe', () => {
  it('removes a subscription by endpoint', async () => {
    await app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })
    const res = await app.request('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/abc' }),
    })
    expect(res.status).toBe(204)
    const c = await pool.connect()
    try {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM plannen.push_subscriptions WHERE user_id = $1',
        [testUserId],
      )
      expect(rows[0].n).toBe(0)
    } finally { c.release() }
  })
})

describe('POST /api/push/test', () => {
  it('returns a delivery summary even with zero subscriptions', async () => {
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey
    const res = await app.request('/api/push/test', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { attempted: number; sent: number; removed: number }
    expect(body.attempted).toBe(0)
    expect(body.sent).toBe(0)
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })
})
