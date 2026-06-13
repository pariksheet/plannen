import { describe, it, expect } from 'vitest'
import { buildWeekAgenda, overlappingIds, ymd, weekDays, eventDateLocal } from './weekAgenda'
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

describe('overlappingIds', () => {
  it('flags both events whose timed ranges intersect', () => {
    const ids = overlappingIds([
      ev({ id: 'a', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'b', start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids).toEqual(new Set(['a', 'b']))
  })

  it('does not flag back-to-back events that only touch', () => {
    const ids = overlappingIds([
      ev({ id: 'a', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'b', start_date: '2026-06-10T12:00:00', end_date: '2026-06-10T13:00:00' }),
    ])
    expect(ids.size).toBe(0)
  })

  it('uses a 2h default window when end_date is missing', () => {
    const ids = overlappingIds([
      ev({ id: 'a', start_date: '2026-06-10T11:00:00', end_date: null }), // 11:00–13:00
      ev({ id: 'b', start_date: '2026-06-10T12:30:00', end_date: null }),
    ])
    expect(ids).toEqual(new Set(['a', 'b']))
  })

  it('ignores all-day (date-only) events', () => {
    const ids = overlappingIds([
      ev({ id: 'allday', start_date: '2026-06-10' }),
      ev({ id: 't', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
    ])
    expect(ids.size).toBe(0)
  })

  it('excludes reminders — they never clash, nor make others clash', () => {
    const ids = overlappingIds([
      ev({ id: 'rem', event_kind: 'reminder', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'evt', start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids.size).toBe(0)
  })

  it("excludes a subject event the owner isn't attending — it never clashes", () => {
    const ids = overlappingIds([
      ev({ id: 'mine', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'kid', subject_kind: 'family_member', subject_id: 'fm1', owner_attends: false,
           start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids.size).toBe(0)
  })

  it('includes a subject event when the owner attends — it clashes normally', () => {
    const ids = overlappingIds([
      ev({ id: 'mine', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'swim', subject_kind: 'family_member', subject_id: 'fm1', owner_attends: true,
           start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids).toEqual(new Set(['mine', 'swim']))
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

describe('buildWeekAgenda with explicit today', () => {
  it('builds next week with all buckets non-today / non-past', () => {
    const now = new Date('2026-06-10T12:00:00')        // Wednesday
    const nextWeekRef = new Date('2026-06-17T12:00:00') // +7d
    const e = ev({ id: 'n1', start_date: '2026-06-18T09:00:00' }) // Thursday next week
    const buckets = buildWeekAgenda([e], nextWeekRef, now)
    expect(buckets.length).toBeGreaterThan(0)
    expect(buckets.every((b) => b.isToday === false)).toBe(true)
    expect(buckets.every((b) => b.isPast === false)).toBe(true)
    expect(buckets.some((b) => b.events.some((x) => x.id === 'n1'))).toBe(true)
  })

  it('two-arg form unchanged: today is flagged', () => {
    const now = new Date('2026-06-10T12:00:00')
    const buckets = buildWeekAgenda([], now)
    const today = buckets.find((b) => b.dateKey === ymd(now))
    expect(today?.isToday).toBe(true)
  })
})
