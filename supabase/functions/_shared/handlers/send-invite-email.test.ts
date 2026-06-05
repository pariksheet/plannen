import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handle } from './send-invite-email.ts'

const ctx = { db: { query: async () => ({ rows: [], rowCount: 0 }) }, userId: 'u1' }

beforeEach(() => {
  process.env.MAILGUN_API_KEY = 'key'
  process.env.MAILGUN_DOMAIN = 'mg.test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MAILGUN_API_KEY
  delete process.env.MAILGUN_DOMAIN
  delete process.env.MAILGUN_FROM_EMAIL
})

describe('send-invite-email handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, ctx)
    expect(res.status).toBe(200)
  })

  it('returns 405 on GET', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, ctx)
    expect(res.status).toBe(405)
  })

  it('returns 500 when Mailgun not configured', async () => {
    delete process.env.MAILGUN_API_KEY
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'foo@bar.com' }),
    })
    const res = await handle(req, ctx)
    expect(res.status).toBe(500)
  })

  it('returns 400 when email malformed', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    const res = await handle(req, ctx)
    expect(res.status).toBe(400)
  })

  it('returns ok when Mailgun responds 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'foo@bar.com' }),
    })
    const res = await handle(req, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
