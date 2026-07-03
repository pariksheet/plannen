import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tier 1/2 path: getChildSessionIds reads sibling rows from supabase, then
// deleteEventSeries removes each child before the master.
type ChildRows = { data: { id: string }[] | null; error: { message: string } | null }
const { del, eqMock } = vi.hoisted(() => ({
  del: vi.fn(async (_id: string): Promise<void> => {}),
  eqMock: vi.fn(async (): Promise<ChildRows> => ({ data: [{ id: 's1' }, { id: 's2' }], error: null })),
}))

vi.mock('../lib/dbClient', () => ({ dbClient: { events: { delete: del } } }))
vi.mock('../lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: eqMock }) }) } }))
vi.mock('../lib/tier', () => ({ isTierZero: () => false }))
vi.mock('../lib/notify', () => ({ notifyEventShared: vi.fn() }))
vi.mock('./agentTaskService', () => ({ createRecurringTask: vi.fn(), createEnrollmentMonitorTask: vi.fn() }))
vi.mock('./groupService', () => ({ setEventSharedWithGroups: vi.fn(), getEventSharedWithGroupIds: vi.fn() }))
vi.mock('./shareService', () => ({ applyDefaultShare: vi.fn(), setShares: vi.fn() }))

import { deleteEventSeries } from './eventService'

beforeEach(() => { del.mockClear(); eqMock.mockReset(); eqMock.mockResolvedValue({ data: [{ id: 's1' }, { id: 's2' }], error: null }) })

describe('deleteEventSeries', () => {
  it('deletes every child session and then the master, master last', async () => {
    const { error } = await deleteEventSeries('master-1')
    expect(error).toBeNull()
    expect(del).toHaveBeenCalledWith('s1')
    expect(del).toHaveBeenCalledWith('s2')
    expect(del).toHaveBeenCalledWith('master-1')
    expect(del.mock.calls[del.mock.calls.length - 1]?.[0]).toBe('master-1')
  })

  it('deletes only the master when it has no child sessions', async () => {
    eqMock.mockResolvedValueOnce({ data: [], error: null })
    const { error } = await deleteEventSeries('master-1')
    expect(error).toBeNull()
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('master-1')
  })

  it('surfaces an error and deletes nothing when listing children fails', async () => {
    eqMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const { error } = await deleteEventSeries('master-1')
    expect(error?.message).toBe('boom')
    expect(del).not.toHaveBeenCalled()
  })
})
