import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock, fromMock, deleteEqMock, isTierZeroMock } = vi.hoisted(() => {
  const deleteEqMock = vi.fn(async () => ({ error: null }))
  const fromMock = vi.fn((_table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => Promise.resolve({
        data: [
          { id: 'inv1', invitee_email: 'newfriend@example.org', created_at: '2026-06-30T00:00:00Z', expires_at: '2026-07-30T00:00:00Z' },
        ],
        error: null,
      }),
      delete: () => ({ eq: deleteEqMock }),
    }
    return builder
  })
  return {
    rpcMock: vi.fn(),
    fromMock,
    deleteEqMock,
    isTierZeroMock: vi.fn(() => false),
  }
})

vi.mock('../lib/supabase', () => ({ supabase: { rpc: rpcMock, from: fromMock } }))
vi.mock('../lib/tier', () => ({ isTierZero: isTierZeroMock }))
vi.mock('../lib/dbClient', () => ({ dbClient: {} }))

import { inviteOrRequest, listSentInvites, cancelInvite } from './relationshipService'

beforeEach(() => {
  rpcMock.mockReset()
  fromMock.mockClear()
  deleteEqMock.mockClear()
  isTierZeroMock.mockReturnValue(false)
})

describe('inviteOrRequest', () => {
  it('returns kind "request" when the email belongs to an existing user', async () => {
    rpcMock.mockResolvedValue({ data: { kind: 'request', rel_id: 'r1' }, error: null })
    const { data, error } = await inviteOrRequest('friend@example.org')
    expect(error).toBeNull()
    expect(data?.kind).toBe('request')
    expect(rpcMock).toHaveBeenCalledWith('invite_or_request_relationship', { target_email: 'friend@example.org' })
  })

  it('returns kind "invite" when the email is unknown', async () => {
    rpcMock.mockResolvedValue({ data: { kind: 'invite', invite_id: 'i1' }, error: null })
    const { data, error } = await inviteOrRequest('stranger@example.org')
    expect(error).toBeNull()
    expect(data?.kind).toBe('invite')
  })

  it('surfaces RPC errors', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const { data, error } = await inviteOrRequest('x@example.org')
    expect(data).toBeNull()
    expect(error?.message).toBe('boom')
  })

  it('is a no-op single-user error in Tier 0', async () => {
    isTierZeroMock.mockReturnValue(true)
    const { data, error } = await inviteOrRequest('x@example.org')
    expect(data).toBeNull()
    expect(error).toBeTruthy()
    expect(rpcMock).not.toHaveBeenCalled()
  })
})

describe('listSentInvites', () => {
  it('returns the inviter\'s pending invites', async () => {
    const { data, error } = await listSentInvites()
    expect(error).toBeNull()
    expect(data.map((i) => i.invitee_email)).toEqual(['newfriend@example.org'])
    expect(fromMock).toHaveBeenCalledWith('relationship_invites')
  })

  it('returns [] in Tier 0', async () => {
    isTierZeroMock.mockReturnValue(true)
    const { data, error } = await listSentInvites()
    expect(error).toBeNull()
    expect(data).toEqual([])
    expect(fromMock).not.toHaveBeenCalled()
  })
})

describe('cancelInvite', () => {
  it('deletes the invite by id', async () => {
    const { error } = await cancelInvite('inv1')
    expect(error).toBeNull()
    expect(deleteEqMock).toHaveBeenCalledWith('id', 'inv1')
  })
})
