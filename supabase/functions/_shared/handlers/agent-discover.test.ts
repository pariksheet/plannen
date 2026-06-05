import { describe, it, expect, vi } from 'vitest'
import { aiMock } from './_testlib/ai.ts'

vi.mock('../ai.ts', () =>
  aiMock({
    generateStructured: async (_ctx, _opts) => ({
      results: [
        { title: 'Foo', url: 'https://example.com/foo' },
        { title: 'Foo2', url: 'https://example.com/foo2' }, // same host — dedup-able
        { title: 'Bar', url: 'https://other.org/bar' },
      ],
    }) as any,
  }),
)

import { handle } from './agent-discover.ts'

function mockCtx(rows: any[] = [{ api_key: 'k', provider: 'anthropic', default_model: null, base_url: null, user_id: 'u1' }]) {
  return {
    db: { query: async () => ({ rows, rowCount: rows.length }) },
    userId: 'u1',
  }
}

describe('agent-discover handler', () => {
  it('returns 204 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(204)
  })

  it('returns 400 when query missing', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(400)
  })

  it('returns deduped results on success', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'jazz festivals' }),
    })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.results).toHaveLength(2) // dedupe collapses example.com/{foo,foo2}
    expect(body.query).toBe('jazz festivals')
  })

  it('propagates no_provider_configured', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
    })
    const res = await handle(req, mockCtx([]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_provider_configured')
  })
})
