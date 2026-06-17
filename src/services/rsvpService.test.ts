import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock, rsvpUpsert, visitUpsert, visitList } = vi.hoisted(() => {
  const rsvpRows = [
    { event_id: 'e1', user_id: 'u1', status: 'going' },
    { event_id: 'e1', user_id: 'u2', status: 'maybe' },
    { event_id: 'e1', user_id: 'u3', status: 'not_going' },
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
  return { fromMock, rsvpUpsert: vi.fn(), visitUpsert: vi.fn(), visitList: vi.fn(async () => []) }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: fromMock } }))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))
vi.mock('../lib/notify', () => ({ notifyRsvp: vi.fn() }))
vi.mock('../lib/dbClient', () => ({
  dbClient: {
    me: { get: async () => ({ userId: 'u1' }) },
    rsvp: { upsert: rsvpUpsert },
    visitPreference: { upsert: visitUpsert, list: visitList },
  },
}))

import { getRsvpList, setPreferredVisitDate, setRsvp } from './rsvpService'

beforeEach(() => {
  fromMock.mockClear()
  rsvpUpsert.mockClear()
  visitUpsert.mockClear()
  visitList.mockClear()
})

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

describe('setPreferredVisitDate — decoupled from RSVP (issue #5)', () => {
  it('writes the visit date without creating or touching an RSVP', async () => {
    const { error } = await setPreferredVisitDate('e9', '2026-07-01')
    expect(error).toBeNull()
    expect(visitUpsert).toHaveBeenCalledWith({ event_id: 'e9', visit_date: '2026-07-01' })
    // The whole point: setting a visit date must not imply an RSVP.
    expect(rsvpUpsert).not.toHaveBeenCalled()
  })

  it('clears the visit date (empty → null) without an RSVP', async () => {
    const { error } = await setPreferredVisitDate('e9', null)
    expect(error).toBeNull()
    expect(visitUpsert).toHaveBeenCalledWith({ event_id: 'e9', visit_date: null })
    expect(rsvpUpsert).not.toHaveBeenCalled()
  })
})

describe('setRsvp', () => {
  it('writes status to the RSVP and routes the visit date to its own table', async () => {
    const { error } = await setRsvp('e9', 'going', '2026-07-02')
    expect(error).toBeNull()
    expect(rsvpUpsert).toHaveBeenCalledWith({ event_id: 'e9', status: 'going' })
    expect(visitUpsert).toHaveBeenCalledWith({ event_id: 'e9', visit_date: '2026-07-02' })
  })

  it('leaves the visit date untouched when none is supplied', async () => {
    const { error } = await setRsvp('e9', 'maybe')
    expect(error).toBeNull()
    expect(rsvpUpsert).toHaveBeenCalledWith({ event_id: 'e9', status: 'maybe' })
    expect(visitUpsert).not.toHaveBeenCalled()
  })
})
