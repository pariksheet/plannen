// supabase/functions/mcp-token/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../_shared/jwt.ts', () => ({
  verifyJwt: vi.fn(),
}))

import { verifyJwt } from '../_shared/jwt.ts'
import { handle } from './index.ts'

function makeCtx(rows: Record<string, unknown[]>) {
  return {
    db: {
      query: vi.fn(async (sql: string, _params: unknown[] = []) => {
        if (sql.includes('INSERT')) return { rows: rows.insert ?? [{ id: 't1' }], rowCount: 1 }
        if (sql.match(/SELECT.*FROM plannen\.user_tokens/i)) return { rows: rows.select ?? [], rowCount: rows.select?.length ?? 0 }
        if (sql.includes('DELETE')) return { rows: [], rowCount: rows.delete?.[0]?.rowCount ?? 1 }
        return { rows: [], rowCount: 0 }
      }),
    },
  }
}

beforeEach(() => {
  (verifyJwt as any).mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('mcp-token handler', () => {
  it('returns 200 + CORS on OPTIONS preflight', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, makeCtx({}) as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('returns 401 when JWT verification fails', async () => {
    ;(verifyJwt as any).mockRejectedValue(new Error('Missing Authorization header'))
    const req = new Request('http://x/', { method: 'POST', body: JSON.stringify({ label: 'a' }) })
    const res = await handle(req, makeCtx({}) as any)
    expect(res.status).toBe(401)
  })

  it('POST mints and returns plaintext once', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'MacBook' }),
    })
    const res = await handle(req, makeCtx({ insert: [{ id: 't-new' }] }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plaintext.startsWith('plnnn_')).toBe(true)
    expect(body.id).toBe('t-new')
    expect(body.label).toBe('MacBook')
  })

  it('POST rejects empty label with 400', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    })
    const res = await handle(req, makeCtx({}) as any)
    expect(res.status).toBe(400)
  })

  it('GET returns caller rows without plaintext', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, makeCtx({
      select: [{ id: 't1', label: 'a', prefix: 'plnnn_aaa', created_at: 'x', last_used_at: null, expires_at: null }],
    }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).not.toHaveProperty('token_hash')
    expect(body[0]).not.toHaveProperty('plaintext')
  })

  it('DELETE 204 on owned token, 404 on missing/not-yours', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')

    const reqOk = new Request('http://x/t1', { method: 'DELETE' })
    const resOk = await handle(reqOk, makeCtx({ delete: [{ rowCount: 1 }] }) as any)
    expect(resOk.status).toBe(204)

    const reqMiss = new Request('http://x/tX', { method: 'DELETE' })
    const resMiss = await handle(reqMiss, makeCtx({ delete: [{ rowCount: 0 }] }) as any)
    expect(resMiss.status).toBe(404)
  })
})
