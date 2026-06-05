import { describe, it, expect } from 'vitest'
// @ts-ignore — .mjs module
import {
  checkPluginManifest,
  parseToolsListResponse,
  checkSupabaseReachable,
  checkMcpTools,
  checkPlannenSchemaExposed,
  checkAuthSiteUrl,
  run,
} from '../../scripts/cloud-doctor.mjs'

describe('checkPluginManifest', () => {
  const VALID_URL = 'https://abc.supabase.co'
  const BEARER = 'tok'

  it('passes on a correctly-shaped HTTP entry', () => {
    const text = JSON.stringify({
      mcpServers: {
        plannen: {
          type: 'http',
          url: 'https://abc.supabase.co/functions/v1/mcp',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    })
    expect(checkPluginManifest(text, { cloudUrl: VALID_URL, bearer: BEARER })).toEqual({
      ok: true,
      reason: '',
    })
  })

  it('fails when type is stdio', () => {
    const text = JSON.stringify({
      mcpServers: { plannen: { type: 'stdio', command: 'node' } },
    })
    expect(
      checkPluginManifest(text, { cloudUrl: VALID_URL, bearer: BEARER }).ok,
    ).toBe(false)
  })

  it('fails on URL mismatch', () => {
    const text = JSON.stringify({
      mcpServers: {
        plannen: {
          type: 'http',
          url: 'https://other.supabase.co/functions/v1/mcp',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    })
    expect(
      checkPluginManifest(text, { cloudUrl: VALID_URL, bearer: BEARER }).ok,
    ).toBe(false)
  })

  it('fails on bearer mismatch', () => {
    const text = JSON.stringify({
      mcpServers: {
        plannen: {
          type: 'http',
          url: 'https://abc.supabase.co/functions/v1/mcp',
          headers: { Authorization: 'Bearer wrong' },
        },
      },
    })
    expect(
      checkPluginManifest(text, { cloudUrl: VALID_URL, bearer: BEARER }).ok,
    ).toBe(false)
  })

  it('fails on missing entry', () => {
    expect(checkPluginManifest('{}', { cloudUrl: VALID_URL, bearer: BEARER }).ok).toBe(false)
  })

  it('fails on invalid JSON', () => {
    expect(checkPluginManifest('{not json', { cloudUrl: VALID_URL, bearer: BEARER }).ok).toBe(
      false,
    )
  })
})

describe('parseToolsListResponse', () => {
  it('returns count from result.tools', () => {
    expect(
      parseToolsListResponse({ result: { tools: [{ name: 'a' }, { name: 'b' }] } }),
    ).toEqual({ ok: true, count: 2, reason: '' })
  })

  it('flags error responses', () => {
    expect(parseToolsListResponse({ error: { message: 'no bearer' } })).toEqual({
      ok: false,
      count: 0,
      reason: 'no bearer',
    })
  })

  it('flags missing result.tools', () => {
    expect(parseToolsListResponse({ result: {} })).toEqual({
      ok: false,
      count: 0,
      reason: 'result.tools missing',
    })
  })

  it('flags non-object body', () => {
    expect(parseToolsListResponse(null).ok).toBe(false)
  })
})

describe('checkSupabaseReachable', () => {
  it('ok on 200 and sends apikey header when provided', async () => {
    const calls: any[] = []
    const fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200 } as Response
    }
    expect(await checkSupabaseReachable('https://abc.supabase.co', 'anon', { fetch: fetch as any })).toEqual({
      ok: true,
      reason: '',
    })
    expect(calls[0].init.headers.apikey).toBe('anon')
  })

  it('not ok on 503', async () => {
    const fetch = async () => ({ ok: false, status: 503 }) as Response
    const r = await checkSupabaseReachable('https://abc.supabase.co', 'anon', { fetch: fetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/503/)
  })

  it('not ok on network error', async () => {
    const fetch = async () => {
      throw new Error('ENOTFOUND')
    }
    const r = await checkSupabaseReachable('https://abc.supabase.co', 'anon', { fetch: fetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/ENOTFOUND/)
  })
})

describe('checkMcpTools', () => {
  it('returns count on 200 with tools', async () => {
    const fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }),
      }) as unknown as Response
    expect(await checkMcpTools('https://x', 'tok', { fetch: fetch as any })).toEqual({
      ok: true,
      count: 3,
      reason: '',
    })
  })

  it('reports HTTP error on non-200', async () => {
    const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response
    expect((await checkMcpTools('https://x', 'tok', { fetch: fetch as any })).ok).toBe(false)
  })

  it('parses SSE-framed responses (text/event-stream content-type)', async () => {
    const fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}\n\n',
      }) as unknown as Response
    const r = await checkMcpTools('https://x', 'tok', { fetch: fetch as any })
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
  })

  it('sends Accept: application/json, text/event-stream', async () => {
    const calls: any[] = []
    const fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'a' }] } }) } as unknown as Response
    }
    await checkMcpTools('https://x', 'tok', { fetch: fetch as any })
    expect(calls[0].init.headers.Accept).toBe('application/json, text/event-stream')
  })
})

describe('checkPlannenSchemaExposed', () => {
  it('passes when the plannen-scoped PostgREST probe returns 200', async () => {
    const fakeFetch = async (_url: string, _init: any) => {
      return { ok: true, status: 200, json: async () => ({ paths: { '/events': {} } }) }
    }
    const r = await checkPlannenSchemaExposed({ supabaseUrl: 'https://abcd.supabase.co', anonKey: 'k' }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(true)
  })

  it('fails with PGRST106 detail when the schema is not exposed', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 406,
      json: async () => ({ code: 'PGRST106', message: 'Invalid schema: plannen' }),
    })
    const r = await checkPlannenSchemaExposed({ supabaseUrl: 'https://abcd.supabase.co', anonKey: 'k' }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/plannen.*not exposed/i)
  })
})

describe('checkAuthSiteUrl', () => {
  it('passes when site_url matches an expected value', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:4321', uri_allow_list: '' }) })
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: 'tok',
      expectedUrls: ['http://localhost:4321', 'https://plannen.vercel.app'],
    }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(true)
  })

  it('fails when site_url is the Supabase localhost default (3000)', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: '' }) })
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: 'tok',
      expectedUrls: ['http://localhost:4321', 'https://plannen.vercel.app'],
    }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/site_url is "http:\/\/localhost:3000"/)
  })

  it('skips cleanly when no access token is provided', async () => {
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: null,
      expectedUrls: [],
    })
    expect(r.ok).toBe(true)
    expect(r.reason).toMatch(/skipped/i)
  })
})

describe('run', () => {
  it('overall pass with cloud reachable + tools + plugin manifest correct', async () => {
    const fetch = async (url: string, init?: any) => {
      if (url.endsWith('/auth/v1/health')) return { ok: true, status: 200 } as Response
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { tools: [{ name: 'a' }] } }),
        } as unknown as Response
      }
      return { ok: true, status: 200 } as Response
    }
    const lines: string[] = []
    const out = await run(
      {
        cloudSupabaseUrl: 'https://abc.supabase.co',
        mcpBearerToken: 'tok',
        pluginManifestPath: '/does-not-exist-on-purpose.json',
      },
      { fetch: fetch as any, log: (s: string) => lines.push(s), readAccessToken: () => null },
    )
    // 3 must-haves: reachable ✓, tools ✓, plugin path missing ✗ (counts as failure)
    // Plus user row + parity + schema + site_url = skipped (ok)
    expect(out.failed).toBe(1)
    expect(lines.join('\n')).toMatch(/cloud reachable.*✓|✓ cloud reachable/)
  })

  it('counts each failed check', async () => {
    const fetch = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response
    const out = await run(
      {
        cloudSupabaseUrl: 'https://abc.supabase.co',
        mcpBearerToken: 'tok',
        pluginManifestPath: '/does-not-exist.json',
      },
      { fetch: fetch as any, log: () => {}, readAccessToken: () => null },
    )
    // reachable fail + tools fail + plugin missing = 3
    expect(out.failed).toBe(3)
  })
})
