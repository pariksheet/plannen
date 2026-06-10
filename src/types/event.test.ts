import { describe, it, expect } from 'vitest'
import { resolveEventStatus, isTodoOverdue, Event } from './event'

const baseTodo: Event = {
  id: 't1', title: 'Renew passport', description: null,
  start_date: '2020-01-01T09:00:00.000Z', end_date: null,
  enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
  image_url: null, location: null, hashtags: null,
  event_kind: 'todo', event_type: 'personal', event_status: 'going',
  created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
  completed_at: null, assigned_to: 'u1',
}

describe('todo status + overdue', () => {
  it('resolveEventStatus never auto-flips a past todo to past/missed', () => {
    const resolved = resolveEventStatus(baseTodo)
    expect(resolved.event_status).toBe('going')
  })

  it('isTodoOverdue is true for an open todo whose start_date has passed', () => {
    expect(isTodoOverdue(baseTodo, new Date('2026-06-09T00:00:00Z'))).toBe(true)
  })

  it('isTodoOverdue is false once completed', () => {
    expect(isTodoOverdue({ ...baseTodo, completed_at: '2026-06-08T00:00:00Z' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })

  it('isTodoOverdue is false for a future todo', () => {
    expect(isTodoOverdue({ ...baseTodo, start_date: '2999-01-01T00:00:00Z' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })

  it('isTodoOverdue is false for non-todo kinds', () => {
    expect(isTodoOverdue({ ...baseTodo, event_kind: 'reminder' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })
})
