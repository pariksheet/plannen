import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { aiMock } from './_testlib/ai.ts'

const FAKE_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) // JFIF magic

vi.mock('../ai.ts', () =>
  aiMock({
    generateFromImage: async () =>
      JSON.stringify({
        title: 'Test Event',
        description: 'A test event',
        start_date: '2026-06-01',
        start_time: '14:00',
        end_date: null,
        end_time: null,
        enrollment_deadline: null,
        location: 'Brussels, Belgium',
      }),
  }),
)

import { handle } from './agent-extract-image.ts'

function mockCtx(rows: any[] = [{ api_key: 'k', provider: 'anthropic', default_model: null, base_url: null, user_id: 'u1' }]) {
  return {
    db: { query: async () => ({ rows, rowCount: rows.length }) },
    userId: 'u1',
  }
}

beforeEach(() => {
  // Stub global fetch so the image-fetch step is hermetic.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'https://example.com/poster.jpg') {
        return new Response(FAKE_JPEG_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })
      }
      return new Response('not found', { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent-extract-image handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
  })

  it('returns 400 when image_url missing', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(400)
  })

  it('extracts fields from a JPEG', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: 'https://example.com/poster.jpg' }),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.extracted.title).toBe('Test Event')
    expect(body.extracted.location).toBe('Brussels, Belgium')
    expect(body.method).toBe('image')
  })

  it('returns no_provider_configured if user has no settings row', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: 'https://example.com/poster.jpg' }),
    })
    const res = await handle(req, mockCtx([]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_provider_configured')
  })
})
