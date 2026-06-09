import { describe, it, expect, vi, beforeEach } from 'vitest'

const { update } = vi.hoisted(() => {
  const update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: 'e1', ...patch }))
  return { update }
})

vi.mock('../lib/dbClient', () => ({
  dbClient: {
    me: { get: async () => ({ userId: 'u1' }) },
    events: { update },
  },
}))

vi.mock('../lib/supabase', () => ({ supabase: {} }))
vi.mock('../lib/tier', () => ({ isTierZero: () => true }))
vi.mock('../lib/notify', () => ({ notifyEventShared: vi.fn() }))
vi.mock('./agentTaskService', () => ({
  createRecurringTask: vi.fn(),
  createEnrollmentMonitorTask: vi.fn(),
}))
vi.mock('./groupService', () => ({
  setEventSharedWithGroups: vi.fn(),
  getEventSharedWithGroupIds: vi.fn(),
}))

import { completeTodo, uncompleteTodo, convertEventKind } from './eventService'

beforeEach(() => update.mockClear())

describe('todo service ops', () => {
  it('completeTodo sets a completed_at timestamp', async () => {
    await completeTodo('e1')
    expect(update).toHaveBeenCalledWith('e1', expect.objectContaining({ completed_at: expect.any(String) }))
  })

  it('uncompleteTodo clears completed_at', async () => {
    await uncompleteTodo('e1')
    expect(update).toHaveBeenCalledWith('e1', { completed_at: null })
  })

  it('convertEventKind to reminder clears completed_at', async () => {
    await convertEventKind('e1', 'reminder')
    expect(update).toHaveBeenCalledWith('e1', { event_kind: 'reminder', completed_at: null })
  })

  it('convertEventKind to todo leaves completion untouched', async () => {
    await convertEventKind('e1', 'todo')
    expect(update).toHaveBeenCalledWith('e1', { event_kind: 'todo' })
  })
})
