import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../googleOAuth.ts', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh', expires_in: 3600 })),
}))

import { handle } from './picker-session-create.ts'

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'u1',
  }
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid'
  process.env.GOOGLE_CLIENT_SECRET = 'csec'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
})

describe('picker-session-create handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(200)
  })

  it('returns 405 on GET', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(405)
  })

  it('returns 404 if no google tokens', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(404)
  })

  it('creates a session and returns Google response when tokens valid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'session-1', pickerUri: 'https://picker' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.includes('SELECT')) {
          return {
            rows: [
              {
                access_token: 'aaa',
                expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                refresh_token: 'rrr',
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 1 }
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('session-1')
  })
})
