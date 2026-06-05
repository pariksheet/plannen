import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../googleOAuth.ts', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh', expires_in: 3600 })),
}))

import { handle } from './get-google-access-token.ts'

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
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
})

describe('get-google-access-token handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(200)
  })

  it('returns 405 on POST', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(405)
  })

  it('returns 404 when no google token row', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(404)
  })

  it('returns stored access_token when still fresh', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx(() => ({
        rows: [
          {
            access_token: 'stored',
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            refresh_token: 'rrr',
          },
        ],
        rowCount: 1,
      })),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.access_token).toBe('stored')
  })

  it('refreshes when near expiry', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    let updateCalled = false
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
          return {
            rows: [
              {
                access_token: 'stale',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                refresh_token: 'rrr',
              },
            ],
            rowCount: 1,
          }
        }
        if (sql.trim().toUpperCase().startsWith('UPDATE')) {
          updateCalled = true
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.access_token).toBe('fresh')
    expect(updateCalled).toBe(true)
  })
})
