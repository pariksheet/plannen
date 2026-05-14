import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { handle } from './get-google-auth-url.ts'

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'u1',
  }
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid'
  process.env.SUPABASE_URL = 'http://supabase.local'
})

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.SUPABASE_URL
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI
})

describe('get-google-auth-url handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(200)
  })

  it('returns 405 on DELETE', async () => {
    const req = new Request('http://x/', { method: 'DELETE' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(405)
  })

  it('returns consent URL and state', async () => {
    const inserts: unknown[][] = []
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx((sql, params) => {
        if (sql.includes('INSERT INTO plannen.oauth_state')) {
          inserts.push(params)
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(body.url).toContain('client_id=cid')
    expect(body.state).toBeTruthy()
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toBe(body.state)
    expect(inserts[0][1]).toBe('u1')
  })

  it('returns 500 when GOOGLE_CLIENT_ID missing', async () => {
    delete process.env.GOOGLE_CLIENT_ID
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(500)
  })
})
