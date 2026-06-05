// Integration test for the Node-side picker-session-poll handler.
// Runs with the real local-fs storage adapter so that upload + signedUrl
// are exercised against the filesystem rather than a mock.
// Lives in the overlay so prepare-shared copies it into backend/src/_shared/
// where the backend vitest project picks it up.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../googleOAuth.js', () => ({
  refreshGoogleAccessToken: vi.fn(async () => ({ access_token: 'fresh', expires_in: 3600 })),
}))

import { handle } from './picker-session-poll.js'
import { _resetStorageForTests } from '../storage/factory.js'

let photosRoot: string

beforeAll(() => {
  photosRoot = mkdtempSync(join(tmpdir(), 'plannen-picker-'))
  process.env.PLANNEN_PHOTOS_ROOT = photosRoot
  process.env.PLANNEN_STORAGE_BACKEND = 'local-fs'
  _resetStorageForTests()
})

afterAll(() => {
  rmSync(photosRoot, { recursive: true, force: true })
  delete process.env.PLANNEN_PHOTOS_ROOT
  delete process.env.PLANNEN_STORAGE_BACKEND
})

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'u1',
  }
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid'
  process.env.GOOGLE_CLIENT_SECRET = 'csec'
  _resetStorageForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
})

describe('picker-session-poll handler (Node/local-fs integration)', () => {
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

  it('downloads, uploads via local-fs adapter, inserts memory row with storage_key', async () => {
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

    // storage_key is the 6th param (index 5) in the INSERT — bare canonical key.
    const insertParams = inserts[0] as unknown[]
    expect(typeof insertParams[5]).toBe('string')
    expect(insertParams[5]).toMatch(/^u1\/e1\/g1\.jpg$/)

    // media_url is the 5th param (index 4) — a signed URL from the adapter.
    expect(typeof insertParams[4]).toBe('string')
    expect(insertParams[4]).toContain('u1/e1/g1.jpg')

    // The file should exist on disk under photosRoot/event-photos/<key>.
    const storedPath = join(photosRoot, 'event-photos', 'u1', 'e1', 'g1.jpg')
    expect(existsSync(storedPath)).toBe(true)
  })
})
