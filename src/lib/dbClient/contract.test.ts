// Contract: every domain key on tier0 must expose the SAME set of method
// names as tier1. Catches the "I added a method to one tier and forgot the
// other" bug. Also smoke-tests the two most-trafficked methods (events.list,
// me.get) end-to-end against mocked transports to confirm the result shapes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Build a chainable thenable that resolves to { data: [], error: null }.
// All builder methods return the same thenable so any chain length works.
type Mockable = { then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => unknown } & Record<string, unknown>

function makeChainable(): Mockable {
  const result = { data: [] as unknown[], error: null as null }
  const m: Mockable = {
    then: (resolve) => resolve(result),
  }
  const methods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'or', 'gte', 'lte', 'gt', 'lt', 'is',
    'order', 'limit', 'range',
  ]
  for (const k of methods) m[k] = () => m
  m.single = () => Promise.resolve({ data: { id: 'x' }, error: null })
  m.maybeSingle = () => Promise.resolve({ data: { id: 'x' }, error: null })
  return m
}

vi.mock('../supabase', () => {
  return {
    supabase: {
      from: () => makeChainable(),
      rpc: () => makeChainable(),
      auth: {
        getUser: () => Promise.resolve({ data: { user: { id: 'u', email: 'e@x' } }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
      functions: {
        invoke: () => Promise.resolve({ data: {}, error: null }),
      },
      storage: {
        from: () => ({
          upload: () => Promise.resolve({ data: { path: 'x' }, error: null }),
          getPublicUrl: () => ({ data: { publicUrl: '/x' } }),
        }),
      },
      channel: () => ({
        on: () => ({ subscribe: () => ({}) }),
      }),
      removeChannel: () => {},
    },
  }
})

import { tier0 } from './tier0'
import { tier1 } from './tier1'

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const data = url.endsWith('/api/me') ? { userId: 'u', email: 'e@x' } : []
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

const domains = [
  'events', 'stories', 'memories', 'profile', 'relationships',
  'locations', 'sources', 'watch', 'rsvp', 'groups', 'wishlist',
  'settings', 'agentTasks', 'me', 'functions', 'realtime',
] as const

describe('dbClient contract — same surface on both tiers', () => {
  for (const d of domains) {
    it(`tier0.${d} and tier1.${d} expose the same method names`, () => {
      const t0 = Object.keys(tier0[d] as object).sort()
      const t1 = Object.keys(tier1[d] as object).sort()
      expect(t0).toEqual(t1)
    })
  }

  it('events.list returns an array (both tiers)', async () => {
    const a = await tier0.events.list()
    const b = await tier1.events.list()
    expect(Array.isArray(a)).toBe(true)
    expect(Array.isArray(b)).toBe(true)
  })

  it('me.get returns an object with userId (both tiers)', async () => {
    const a = await tier0.me.get()
    const b = await tier1.me.get()
    expect(a).toHaveProperty('userId')
    expect(b).toHaveProperty('userId')
  })
})
