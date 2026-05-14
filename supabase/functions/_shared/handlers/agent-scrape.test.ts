import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { aiMock } from './_testlib/ai.ts'

vi.mock('../ai.ts', () =>
  aiMock({
    generateStructured: async () =>
      ({
        title: 'Scraped Title',
        description: 'A nice event',
        start_date: '2026-09-01',
        start_time: '19:30',
        end_date: '2026-09-01',
        end_time: '22:00',
        enrollment_deadline: null,
        location: 'Antwerp',
      }) as any,
  }),
)

import { handle } from './agent-scrape.ts'

const HTML_PAGE = `<!DOCTYPE html><html><head>
  <title>Cool Event | Site</title>
  <meta property="og:image" content="https://example.com/cover.jpg">
</head><body>
  <h1>Cool Event</h1>
  <p>Welcome to our event.</p>
</body></html>`

function mockCtx(opts: { rows?: any[]; capture?: { sql: string; params: unknown[] }[] } = {}) {
  const capture = opts.capture
  const rows = opts.rows ?? [{ api_key: 'k', provider: 'anthropic', default_model: null, base_url: null, user_id: 'u1' }]
  return {
    db: {
      query: async (sql: string, params: unknown[] = []) => {
        if (capture) capture.push({ sql, params })
        // Always return the AI settings shape for the user_settings probe;
        // events UPDATE returns no rows.
        if (sql.toUpperCase().includes('FROM PLANNEN.USERS') || sql.toLowerCase().includes('user_settings')) {
          return { rows, rowCount: rows.length }
        }
        if (sql.trim().toUpperCase().startsWith('UPDATE')) return { rows: [], rowCount: rows.length }
        return { rows, rowCount: rows.length }
      },
    },
    userId: 'u1',
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'https://example.com/event') {
        return new Response(HTML_PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      return new Response('not found', { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent-scrape handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
  })

  it('returns 400 when url missing', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(400)
  })

  it('returns LLM extraction when AI configured', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/event' }),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.method).toBe('llm')
    expect(body.extracted.title).toBe('Scraped Title')
    expect(body.extracted.location).toBe('Antwerp')
  })

  it('falls back to regex extraction when AI not configured', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/event' }),
    })
    const res = await handle(req, mockCtx({ rows: [] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.method).toBe('regex')
    expect(body.extracted.title).toBeTruthy()
    expect(body.extracted.image_url).toBe('https://example.com/cover.jpg')
  })

  it('issues an UPDATE when event_id is given', async () => {
    const capture: { sql: string; params: unknown[] }[] = []
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/event', event_id: 'evt-1' }),
    })
    const res = await handle(req, mockCtx({ capture }))
    expect(res.status).toBe(200)
    const updates = capture.filter((c) => c.sql.trim().toUpperCase().startsWith('UPDATE PLANNEN.EVENTS'))
    expect(updates.length).toBe(1)
    expect(updates[0].params[updates[0].params.length - 1]).toBe('evt-1')
  })
})
