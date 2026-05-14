import { describe, it, expect, vi } from 'vitest'

// Mock the AI module so the handler can import it without resolving
// the Deno-style `npm:ai@4` etc. specifiers inside ai.ts.
vi.mock('../ai.ts', () => {
  class AIError extends Error {
    code: string
    retryAfterSeconds: number | null
    status: number
    constructor(code: string, message: string, opts: { status?: number; retryAfterSeconds?: number | null } = {}) {
      super(message)
      this.name = 'AIError'
      this.code = code
      this.retryAfterSeconds = opts.retryAfterSeconds ?? null
      this.status = opts.status ?? 500
    }
  }
  class AIProviderNotConfigured extends AIError {
    constructor() {
      super('no_provider_configured', 'No AI provider configured for this user.', { status: 400 })
    }
  }
  return {
    AIError,
    AIProviderNotConfigured,
    aiErrorResponse: (err: any, cors: Record<string, string>) => {
      const e = err instanceof AIError ? err : new AIError('unknown_error', String(err?.message ?? err))
      return new Response(
        JSON.stringify({ success: false, error: e.code, message: e.message }),
        { status: e.status, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    },
    getUserAI: async (ctx: any) => {
      const { rows } = await ctx.db.query('select')
      if (rows.length === 0 || !rows[0].api_key) throw new AIProviderNotConfigured()
      return rows[0]
    },
    generate: async (ctx: any) => {
      const { rows } = await ctx.db.query('select')
      if (rows.length === 0 || !rows[0].api_key) throw new AIProviderNotConfigured()
      return 'ok'
    },
    generateStructured: async () => ({}),
    generateFromImage: async () => 'mock-image-response',
    withRetryAndTracking: async (_ctx: any, _s: any, fn: () => any) => fn(),
  }
})

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
