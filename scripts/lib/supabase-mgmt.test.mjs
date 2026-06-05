import { describe, it, expect, vi } from 'vitest'
import { updateAuthConfig, mergeAllowList } from './supabase-mgmt.mjs'

function makeFetch(currentConfig) {
  const calls = []
  const fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    if (init.method === 'GET') {
      return { ok: true, status: 200, json: async () => currentConfig }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  return { fetch, calls }
}

const EPHEMERAL = /^https:\/\/plannen-[a-z0-9]+-[^.]+\.vercel\.app(\/\*\*)?$/

describe('updateAuthConfig allow-list pruning', () => {
  it('drops stale entries matching pruneAllowList and keeps everything else', async () => {
    const { fetch, calls } = makeFetch({
      site_url: 'https://plannen.vercel.app',
      uri_allow_list: [
        'http://localhost:4321/**',
        'https://plannen.vercel.app/**',
        'https://plannen-aaa111-scope-projects.vercel.app/**',
        'https://plannen-bbb222-scope-projects.vercel.app/**',
      ].join(','),
    })
    const result = await updateAuthConfig('tok', 'ref1', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen-ccc333-scope-projects.vercel.app/**'],
      pruneAllowList: EPHEMERAL,
    }, { fetch })
    expect(result.changed).toBe(true)
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch.body.uri_allow_list).toBe([
      'http://localhost:4321/**',
      'https://plannen.vercel.app/**',
      'https://plannen-ccc333-scope-projects.vercel.app/**',
    ].join(','))
  })

  it('detects changes by content, not length (prune one + add one)', async () => {
    const { fetch, calls } = makeFetch({
      site_url: 'https://plannen.vercel.app',
      uri_allow_list: 'https://plannen-aaa111-scope-projects.vercel.app/**',
    })
    const result = await updateAuthConfig('tok', 'ref1', {
      addAllowList: ['https://plannen-bbb222-scope-projects.vercel.app/**'],
      pruneAllowList: EPHEMERAL,
    }, { fetch })
    expect(result.changed).toBe(true)
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch.body.uri_allow_list).toBe('https://plannen-bbb222-scope-projects.vercel.app/**')
  })

  it('is a no-op when pruning matches nothing and additions already exist', async () => {
    const { fetch, calls } = makeFetch({
      site_url: 'https://plannen.vercel.app',
      uri_allow_list: 'https://plannen.vercel.app/**',
    })
    const result = await updateAuthConfig('tok', 'ref1', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen.vercel.app/**'],
      pruneAllowList: EPHEMERAL,
    }, { fetch })
    expect(result.changed).toBe(false)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('unions without pruning when pruneAllowList is absent (legacy behavior)', async () => {
    const { fetch, calls } = makeFetch({
      site_url: 'https://x.example',
      uri_allow_list: 'https://a.example/**',
    })
    await updateAuthConfig('tok', 'ref1', {
      addAllowList: ['https://b.example/**'],
    }, { fetch })
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch.body.uri_allow_list).toBe('https://a.example/**,https://b.example/**')
  })
})

describe('mergeAllowList', () => {
  it('unions and dedupes preserving order', () => {
    expect(mergeAllowList(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
