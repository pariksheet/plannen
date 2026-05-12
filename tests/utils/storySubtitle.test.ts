import { describe, it, expect } from 'vitest'
import { formatStorySubtitle } from '../../src/utils/storySubtitle'

describe('formatStorySubtitle', () => {
  it('formats a single-event story', () => {
    expect(formatStorySubtitle({
      events: [{ id: 'e1', title: 'Brussels Motor Show', start_date: '2026-01-14T09:00:00Z' }],
    })).toBe('Brussels Motor Show · Jan 14, 2026')
  })

  it('formats a multi-event story with date range in same year', () => {
    expect(formatStorySubtitle({
      events: [
        { id: 'a', title: 'Drive to Stuttgart',  start_date: '2026-03-20T08:00:00Z' },
        { id: 'b', title: 'Dinner with Anna',    start_date: '2026-03-21T19:00:00Z' },
        { id: 'c', title: 'Return drive',        start_date: '2026-03-22T10:00:00Z' },
      ],
    })).toBe('3 events · Mar 20–22, 2026')
  })

  it('formats a multi-event story spanning multiple months', () => {
    expect(formatStorySubtitle({
      events: [
        { id: 'a', title: 'A', start_date: '2026-03-20T00:00:00Z' },
        { id: 'b', title: 'B', start_date: '2026-08-14T00:00:00Z' },
      ],
    })).toBe('2 events · Mar 20 – Aug 14, 2026')
  })

  it('formats a multi-event story spanning years', () => {
    expect(formatStorySubtitle({
      events: [
        { id: 'a', title: 'A', start_date: '2026-03-20T00:00:00Z' },
        { id: 'b', title: 'B', start_date: '2027-02-10T00:00:00Z' },
      ],
    })).toBe('2 events · Mar 2026 – Feb 2027')
  })

  it('falls back to date_from/date_to when no events', () => {
    expect(formatStorySubtitle({
      events: [],
      date_from: '2026-06-01',
      date_to: '2026-06-07',
    })).toBe('Jun 1–7, 2026')
  })

  it('returns "Standalone story" for no events and no dates', () => {
    expect(formatStorySubtitle({ events: [] })).toBe('Standalone story')
  })

  it('handles a single event with missing title', () => {
    expect(formatStorySubtitle({
      events: [{ id: 'e1', title: null, start_date: '2026-01-14T09:00:00Z' }],
    })).toBe('Untitled event · Jan 14, 2026')
  })

  it('handles a single event with missing date', () => {
    expect(formatStorySubtitle({
      events: [{ id: 'e1', title: 'Brussels Motor Show', start_date: null }],
    })).toBe('Brussels Motor Show')
  })
})
