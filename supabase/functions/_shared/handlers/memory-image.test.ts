import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../googleOAuth.ts', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh-token', expires_in: 3600 })),
}))

import { handle } from './memory-image.ts'

type CtxRows = { rows: any[]; rowCount: number }

function mockCtx(handler: (sql: string, params: unknown[]) => CtxRows | Promise<CtxRows>) {
  return {
    db: {
      query: async (sql: string, params: unknown[] = []) => handler(sql, params),
    },
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

describe('memory-image handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/memory-image?memory_id=m1', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(200)
  })

  it('returns 405 on POST', async () => {
    const req = new Request('http://x/memory-image?memory_id=m1', { method: 'POST' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(405)
  })

  it('returns 400 when memory_id is missing', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(400)
  })

  it('redirects to media_url when bytes already cached', async () => {
    const req = new Request('http://x/?memory_id=m1', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.includes('event_memories')) {
          return {
            rows: [
              { id: 'm1', event_id: 'e1', user_id: 'u1', source: 'upload', external_id: null, media_url: 'https://cdn/x.jpg' },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn/x.jpg')
  })

  it('returns 404 when memory not found', async () => {
    const req = new Request('http://x/?memory_id=m1', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(404)
  })

  it('returns 403 when Google not connected for owner', async () => {
    const req = new Request('http://x/?memory_id=m1', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.includes('event_memories')) {
          return {
            rows: [
              { id: 'm1', event_id: 'e1', user_id: 'u1', source: 'google_drive', external_id: 'gd-1', media_url: null },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(403)
  })

  it('proxies google_drive bytes when token valid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    )
    const req = new Request('http://x/?memory_id=m1', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.includes('event_memories')) {
          return {
            rows: [
              { id: 'm1', event_id: 'e1', user_id: 'u1', source: 'google_drive', external_id: 'gd-1', media_url: null },
            ],
            rowCount: 1,
          }
        }
        if (sql.includes('user_oauth_tokens')) {
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
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })
})
