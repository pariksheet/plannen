import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../googleOAuth.ts', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh', expires_in: 3600 })),
}))

import { handle } from './picker-session-poll.ts'

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'u1',
  }
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid'
  process.env.GOOGLE_CLIENT_SECRET = 'csec'
  process.env.STORAGE_PUBLIC_URL_BASE = 'http://storage.local'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.STORAGE_PUBLIC_URL_BASE
})

describe('picker-session-poll handler', () => {
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

  it('returns 400 on missing sessionId/eventId', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(400)
  })

  it('returns "pending" when mediaItemsSet=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ mediaItemsSet: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', eventId: 'e1' }),
    })
    const res = await handle(
      req,
      mockCtx((sql) => {
        if (sql.includes('user_oauth_tokens') && sql.includes('SELECT')) {
          return {
            rows: [{ access_token: 'aaa', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), refresh_token: 'rrr' }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('pending')
  })

  it('downloads, uploads to storage, inserts memory row on success', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.includes('/sessions/s1')) {
          return new Response(JSON.stringify({ mediaItemsSet: true }), { status: 200 })
        }
        if (url.startsWith('https://photospicker.googleapis.com/v1/mediaItems')) {
          return new Response(
            JSON.stringify({
              mediaItems: [
                {
                  id: 'g1',
                  type: 'PHOTO',
                  createTime: '2026-01-01T00:00:00Z',
                  mediaFile: { baseUrl: 'https://lh.googleusercontent.com/x', mimeType: 'image/jpeg', filename: 'x.jpg' },
                },
              ],
            }),
            { status: 200 },
          )
        }
        if (url.startsWith('https://lh.googleusercontent.com/x=w1280')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          })
        }
        if (url.startsWith('http://storage.local/storage/v1/object/event-photos/')) {
          return new Response('', { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }),
    )
    const inserts: unknown[][] = []
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', eventId: 'e1' }),
    })
    const res = await handle(
      req,
      mockCtx((sql, params) => {
        if (sql.includes('user_oauth_tokens') && sql.trim().toUpperCase().startsWith('SELECT')) {
          return {
            rows: [{ access_token: 'aaa', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), refresh_token: 'rrr' }],
            rowCount: 1,
          }
        }
        if (sql.includes('event_memories') && sql.trim().toUpperCase().startsWith('SELECT')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('event_memories') && sql.trim().toUpperCase().startsWith('INSERT')) {
          inserts.push(params)
          return { rows: [{ id: 'mem-1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('complete')
    expect(body.attached).toHaveLength(1)
    expect(body.attached[0].memory_id).toBe('mem-1')
    expect(inserts).toHaveLength(1)
    expect(calls.some((c) => c.startsWith('PUT http://storage.local/storage/v1/object/event-photos/'))).toBe(true)
  })
})
