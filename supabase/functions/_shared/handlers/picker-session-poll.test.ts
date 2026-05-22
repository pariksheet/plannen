import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../googleOAuth.ts', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh', expires_in: 3600 })),
}))

// Mock the storage adapter so this test file runs in both the
// supabase/functions vitest project (no real factory on disk) and
// the backend vitest project (after prepare-shared stages the overlay).
// The overlay test at backend/src/_shared-overlay/handlers/picker-session-poll.test.ts
// exercises the real local-fs adapter end-to-end.
vi.mock('../storage/factory.ts', () => ({
  getStorage: () => ({
    upload: vi.fn(async () => undefined),
    signedUrl: vi.fn(async (_key: string) => `http://storage.mock/event-photos/${_key}`),
    delete: vi.fn(async () => true),
    head: vi.fn(async () => null),
  }),
  _resetStorageForTests: vi.fn(),
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
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
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

  it('downloads, uploads via storage adapter, inserts memory row with storage_key on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
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
    // storage_key (index 5) and media_url (index 4) are both populated
    const insertParams = inserts[0] as unknown[]
    expect(typeof insertParams[5]).toBe('string')
    expect(insertParams[5]).toMatch(/^u1\/e1\/g1\.jpg$/)
    expect(typeof insertParams[4]).toBe('string')
    expect(insertParams[4]).toContain('u1/e1/g1.jpg')
  })
})
