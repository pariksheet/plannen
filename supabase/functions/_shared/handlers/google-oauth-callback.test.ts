import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handle } from './google-oauth-callback.ts'

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'system',
  }
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid'
  process.env.GOOGLE_CLIENT_SECRET = 'csec'
  process.env.SUPABASE_URL = 'http://supabase.local'
  process.env.APP_OAUTH_REDIRECT_URL = 'http://app.local/dashboard'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.SUPABASE_URL
  delete process.env.APP_OAUTH_REDIRECT_URL
})

describe('google-oauth-callback handler', () => {
  it('returns 405 on POST', async () => {
    const req = new Request('http://x/?code=c&state=s', { method: 'POST' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(405)
  })

  it('redirects with error param when google returns ?error=...', async () => {
    const req = new Request('http://x/?error=access_denied', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('error=access_denied')
  })

  it('redirects with missing_code_or_state when code absent', async () => {
    const req = new Request('http://x/?state=s', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('missing_code_or_state')
  })

  it('redirects invalid_or_expired_state if no row found', async () => {
    const req = new Request('http://x/?code=c&state=s', { method: 'GET' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('invalid_or_expired_state')
  })

  it('exchanges code for tokens and upserts on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const queries: { sql: string; params: unknown[] }[] = []
    const req = new Request('http://x/?code=c1&state=s1', { method: 'GET' })
    const res = await handle(
      req,
      mockCtx((sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('FROM plannen.oauth_state')) {
          return { rows: [{ user_id: 'owner-1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google_oauth=success')
    const upsert = queries.find((q) => q.sql.includes('INSERT INTO plannen.user_oauth_tokens'))
    expect(upsert).toBeTruthy()
    expect(upsert!.params[0]).toBe('owner-1')
    expect(upsert!.params[2]).toBe('at')
  })
})
