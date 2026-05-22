import { describe, it, expect, vi } from 'vitest'
import { createSupabaseAdapter } from './supabase.js'

function makeFetch(responses: Array<Partial<Response> & { _body?: unknown }>) {
  const seen: Array<{ url: string; method: string; headers: Record<string,string>; body?: unknown }> = []
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const r = responses.shift()
    if (!r) throw new Error('unexpected extra fetch call')
    const url = typeof input === 'string' ? input : input.toString()
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers ?? {})),
      body: init?.body,
    })
    return new Response(JSON.stringify(r._body ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'application/json' },
    }) as Response
  })
  return Object.assign(fn, { calls: seen })
}

const baseOpts = {
  supabaseUrl: 'https://abc.supabase.co',
  serviceRoleKey: 'svc-key',
}

describe('supabase adapter', () => {
  it('upload POSTs binary bytes with x-upsert and service-role auth', async () => {
    const fetchFn = makeFetch([{ status: 200, _body: { Key: 'event-photos/u/e/x.jpg' } }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    await a.upload('u/e/x.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })
    expect(fetchFn.calls[0].url).toBe('https://abc.supabase.co/storage/v1/object/event-photos/u/e/x.jpg')
    expect(fetchFn.calls[0].method).toBe('POST')
    expect(fetchFn.calls[0].headers['authorization']).toBe('Bearer svc-key')
    expect(fetchFn.calls[0].headers['content-type']).toBe('image/jpeg')
    expect(fetchFn.calls[0].headers['x-upsert']).toBe('true')
  })

  it('signedUrl POSTs to /storage/v1/object/sign and returns absolute URL', async () => {
    const fetchFn = makeFetch([{
      status: 200,
      _body: { signedURL: '/storage/v1/object/sign/event-photos/u/e/x.jpg?token=t' },
    }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    const url = await a.signedUrl('u/e/x.jpg', { ttlSeconds: 900 })
    expect(fetchFn.calls[0].url).toBe('https://abc.supabase.co/storage/v1/object/sign/event-photos/u/e/x.jpg')
    expect(JSON.parse(String(fetchFn.calls[0].body))).toEqual({ expiresIn: 900 })
    expect(url).toBe('https://abc.supabase.co/storage/v1/object/sign/event-photos/u/e/x.jpg?token=t')
  })

  it('delete returns false when supabase reports the object missing', async () => {
    // Simulate the missing-then-delete path:
    const fetch2 = makeFetch([{ status: 404 }])
    const b = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetch2 })
    expect(await b.delete('u/e/missing.jpg')).toBe(false)
  })

  it('head returns null on 404', async () => {
    const fetchFn = makeFetch([{ status: 404 }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    expect(await a.head('u/e/missing.jpg')).toBeNull()
  })
})
