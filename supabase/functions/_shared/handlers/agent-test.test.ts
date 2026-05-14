import { describe, it, expect, vi } from 'vitest'
import { aiMock } from './_testlib/ai.ts'

vi.mock('../ai.ts', () => aiMock())

import { handle } from './agent-test.ts'

type MockRow = { api_key: string | null; provider: string; default_model: string | null; base_url: string | null; user_id: string }

function mockCtx(rows: MockRow[] = [{ api_key: 'k', provider: 'anthropic', default_model: null, base_url: null, user_id: 'u1' }]) {
  return {
    db: { query: async () => ({ rows, rowCount: rows.length }) },
    userId: 'u1',
  }
}

describe('agent-test handler', () => {
  it('returns 204 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('returns 405 on GET', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(405)
  })

  it('returns success when AI replies', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(typeof body.sample).toBe('string')
  })

  it('returns no_provider_configured if user has no settings row', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, mockCtx([]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_provider_configured')
  })
})
