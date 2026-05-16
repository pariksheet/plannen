import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import {
  checkPluginManifest,
  parseToolsListResponse,
  checkSupabaseReachable,
  checkMcpTools,
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
  it('ok on 200', async () => {
    const fetch = async () => ({ ok: true, status: 200 }) as Response
    expect(await checkSupabaseReachable('https://abc.supabase.co', { fetch: fetch as any })).toEqual({
      ok: true,
      reason: '',
    })
  })

  it('not ok on 503', async () => {
    const fetch = async () => ({ ok: false, status: 503 }) as Response
    const r = await checkSupabaseReachable('https://abc.supabase.co', { fetch: fetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/503/)
  })

  it('not ok on network error', async () => {
    const fetch = async () => {
      throw new Error('ENOTFOUND')
    }
    const r = await checkSupabaseReachable('https://abc.supabase.co', { fetch: fetch as any })
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
      { fetch: fetch as any, log: (s: string) => lines.push(s) },
    )
    // 3 must-haves: reachable ✓, tools ✓, plugin path missing ✗ (counts as failure)
    // Plus user row + parity = skipped (ok)
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
      { fetch: fetch as any, log: () => {} },
    )
    // reachable fail + tools fail + plugin missing = 3
    expect(out.failed).toBe(3)
  })
})
