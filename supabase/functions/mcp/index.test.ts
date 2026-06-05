import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { authenticate, handleRequest } from './index.ts'
import * as userTokensModule from '../_shared/userTokens.ts'
import * as jwtModule from '../_shared/jwt.ts'

describe('authenticate', () => {
  it('returns the bearer when header is well-formed and prefixed plnnn_', async () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer plnnn_abc123' },
    })
    const r = await authenticate(req)
    expect(r).not.toBeInstanceOf(Response)
    expect((r as { bearer: string }).bearer).toBe('plnnn_abc123')
  })

  it('returns 401 missing_bearer when header is absent', async () => {
    const req = new Request('http://x/')
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    const res = r as Response
    expect(res.status).toBe(401)
    expect(await res.clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 missing_bearer when header is missing Bearer prefix', async () => {
    const req = new Request('http://x/', { headers: { Authorization: 'plnnn_abc' } })
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 invalid_token when bearer is neither plnnn_ nor a valid JWT', async () => {
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue(null)
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wrongtoken' },
    })
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'invalid_token' })
    vi.restoreAllMocks()
  })

  it('returns the userId when bearer is a valid Supabase JWT', async () => {
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue('u-jwt-1')
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.x.y' },
    })
    const r = await authenticate(req)
    expect(r).not.toBeInstanceOf(Response)
    expect((r as { userId: string }).userId).toBe('u-jwt-1')
    vi.restoreAllMocks()
  })
})

describe('handleRequest (transport)', () => {
  beforeEach(() => {
    vi.spyOn(userTokensModule, 'resolveTokenToUserId').mockResolvedValue('u-test')
    delete process.env.MCP_BEARER_TOKEN
    delete process.env.PLANNEN_USER_EMAIL
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('responds to tools/list with an empty list when no tool modules are registered', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer plnnn_test',
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result?.tools).toEqual([])
  })
})

describe('multi-user isolation', () => {
  beforeEach(() => {
    delete process.env.MCP_BEARER_TOKEN
    delete process.env.PLANNEN_USER_EMAIL
  })

  it('two requests with different PATs get different userIds in handler ctx', async () => {
    const seenUserIds: string[] = []
    const fakeTool: any = {
      definitions: [{ name: 'echo_user', description: 'd', inputSchema: { type: 'object' } }],
      dispatch: {
        echo_user: async (_args: unknown, ctx: { userId: string }) => {
          seenUserIds.push(ctx.userId)
          return { userId: ctx.userId }
        },
      },
    }

    // Each bearer maps to a different user.
    vi.spyOn(userTokensModule, 'resolveTokenToUserId').mockImplementation(
      async (_c, plaintext: string) => (plaintext === 'plnnn_A' ? 'u-A' : 'u-B'),
    )

    // Mock the pool so we don't hit a real DB.
    const fakeClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    }
    const poolMod = await import('./server.ts')
    vi.spyOn(poolMod.pool, 'connect').mockResolvedValue(fakeClient as any)

    const callBody = (id: number) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'echo_user', arguments: {} },
    })

    const r1 = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer plnnn_A',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: callBody(1),
      }),
      { tools: [fakeTool] },
    )
    expect(r1.status).toBe(200)

    const r2 = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer plnnn_B',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: callBody(2),
      }),
      { tools: [fakeTool] },
    )
    expect(r2.status).toBe(200)

    expect(seenUserIds).toEqual(['u-A', 'u-B'])
  })

  it('a JWT bearer reaches the handler with the verified userId and skips token lookup', async () => {
    const seenUserIds: string[] = []
    const fakeTool: any = {
      definitions: [{ name: 'echo_user', description: 'd', inputSchema: { type: 'object' } }],
      dispatch: {
        echo_user: async (_args: unknown, ctx: { userId: string }) => {
          seenUserIds.push(ctx.userId)
          return { userId: ctx.userId }
        },
      },
    }
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue('u-oauth')
    const resolveSpy = vi.spyOn(userTokensModule, 'resolveTokenToUserId')

    const fakeClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    }
    const poolMod = await import('./server.ts')
    vi.spyOn(poolMod.pool, 'connect').mockResolvedValue(fakeClient as any)

    const res = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.x.y',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'echo_user', arguments: {} },
        }),
      }),
      { tools: [fakeTool] },
    )
    expect(res.status).toBe(200)
    expect(seenUserIds).toEqual(['u-oauth'])
    expect(resolveSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('oauth discovery', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://test-ref.supabase.co'
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
  })

  it('serves RFC 9728 protected-resource metadata without auth', async () => {
    const req = new Request(
      'http://x/mcp/.well-known/oauth-protected-resource',
      { method: 'GET' },
    )
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe('https://test-ref.supabase.co/functions/v1/mcp')
    expect(body.authorization_servers).toEqual(['https://test-ref.supabase.co/auth/v1'])
    expect(body.bearer_methods_supported).toEqual(['header'])
  })

  it('401 responses carry a WWW-Authenticate header pointing at the metadata', async () => {
    const req = new Request('http://x/mcp', { method: 'POST' })
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(401)
    const www = res.headers.get('WWW-Authenticate') ?? ''
    expect(www).toContain('Bearer')
    expect(www).toContain(
      'resource_metadata="https://test-ref.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource"',
    )
  })
})
