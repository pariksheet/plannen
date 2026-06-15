import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rsvpRows, userRows, fromMock } = vi.hoisted(() => {
  const rsvpRows = [
    { event_id: 'e1', user_id: 'u1', status: 'going', preferred_visit_date: null },
    { event_id: 'e1', user_id: 'u2', status: 'maybe', preferred_visit_date: null },
    { event_id: 'e1', user_id: 'u3', status: 'not_going', preferred_visit_date: null },
  ]
  const userRows = [
    { id: 'u1', email: 'a@example.org', full_name: 'Alice' },
    { id: 'u2', email: 'b@example.org', full_name: 'Bob' },
    // u3 intentionally missing → should degrade to id-only
  ]
  const fromMock = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      in: () => Promise.resolve({ data: table === 'event_rsvps' ? rsvpRows : userRows, error: null }),
    }
    return builder
  })
  return { rsvpRows, userRows, fromMock }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: fromMock } }))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))
vi.mock('../lib/notify', () => ({ notifyRsvp: vi.fn() }))
vi.mock('../lib/dbClient', () => ({ dbClient: { me: { get: async () => ({ userId: 'u1' }) }, rsvp: { upsert: vi.fn() } } }))

import { getRsvpList } from './rsvpService'

beforeEach(() => fromMock.mockClear())

describe('getRsvpList', () => {
  it('buckets RSVPs by status and hydrates names (degrading to id-only)', async () => {
    const { data, error } = await getRsvpList('e1')
    expect(error).toBeNull()
    expect(data?.going.map((u) => u.full_name)).toEqual(['Alice'])
    expect(data?.maybe.map((u) => u.full_name)).toEqual(['Bob'])
    // u3 had no users row → name fields undefined, id preserved
    expect(data?.not_going).toEqual([{ id: 'u3', email: undefined, full_name: undefined }])
  })
})
