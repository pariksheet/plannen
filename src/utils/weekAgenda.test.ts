import { describe, it, expect } from 'vitest'
import { buildWeekAgenda, ymd, weekDays, eventDateLocal } from './weekAgenda'
import { Event } from '../types/event'

function ev(overrides: Partial<Event>): Event {
  return {
    id: 'e', title: 'Untitled', description: null,
    start_date: '2026-06-10', end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'event', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: '2026-06-10', updated_at: '2026-06-10',
    shared_with_friends: 'none', ...overrides,
  } as Event
}

// Wednesday 2026-06-10 (week Mon 8 … Sun 14)
const NOW = new Date('2026-06-10T09:00:00')

describe('buildWeekAgenda', () => {
  it('always includes today even with no events, omitting other empty days', () => {
    const buckets = buildWeekAgenda([], NOW)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].isToday).toBe(true)
    expect(buckets[0].dateKey).toBe(ymd(NOW))
    expect(buckets[0].events).toHaveLength(0)
    expect(buckets[0].isPast).toBe(false)
  })

  it('buckets events onto their local day and sorts within a day', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'b', title: 'B', start_date: '2026-06-10T18:00:00' }),
      ev({ id: 'a', title: 'A', start_date: '2026-06-10T08:00:00' }),
    ], NOW)
    const today = buckets.find((d) => d.isToday)!
    expect(today.events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('includes reminders, including past ones in the week', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'r', title: 'Renew books', event_kind: 'reminder', start_date: '2026-06-08' }),
    ], NOW)
    const mon = buckets.find((d) => d.dateKey === '2026-06-08')!
    expect(mon.isPast).toBe(true)
    expect(mon.events.map((e) => e.id)).toEqual(['r'])
  })

  it('excludes recurrence parents and out-of-week events', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'p', title: 'Parent', recurrence_rule: { frequency: 'weekly' } as unknown as Event['recurrence_rule'], start_date: '2026-06-10' }),
      ev({ id: 'far', title: 'Far', start_date: '2026-07-01' }),
    ], NOW)
    const all = buckets.flatMap((d) => d.events.map((e) => e.id))
    expect(all).not.toContain('p')
    expect(all).not.toContain('far')
  })
})

describe('weekDays', () => {
  it('when now is a Sunday, week starts Monday and ends Sunday', () => {
    const sunday = new Date('2026-06-14T09:00:00')
    const days = weekDays(sunday)
    expect(ymd(days[0])).toBe('2026-06-08')
    expect(ymd(days[6])).toBe('2026-06-14')
  })

  it('when now is a Monday, week starts that Monday', () => {
    const monday = new Date('2026-06-08T09:00:00')
    const days = weekDays(monday)
    expect(ymd(days[0])).toBe('2026-06-08')
  })
})

describe('eventDateLocal', () => {
  it('resolves a timestamp to the local date (timezone-robust)', () => {
    const timestamp = '2026-06-10T08:00:00'
    const expected = ymd(new Date(timestamp))
    const result = eventDateLocal(ev({ start_date: timestamp }))
    expect(result).toBe(expected)
  })
})
