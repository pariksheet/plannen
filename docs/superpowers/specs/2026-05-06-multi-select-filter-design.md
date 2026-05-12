# Multi-Select Kind and Status Filters

**Date:** 2026-05-06  
**Status:** Approved

## Overview

Replace single-select kind and status filters (with "All" pill) with multi-select toggles. Clicking a pill selects it; clicking again deselects it. Nothing selected = show all. Remove "All" pills from both filter rows.

## State

```ts
const [activeKindFilter, setActiveKindFilter] = useState<Set<'event' | 'reminder'>>(new Set())
const [activeStatusFilter, setActiveStatusFilter] = useState<Set<EventStatus>>(new Set())
```

Empty set = no filter active = show everything.

## Toggle Handlers

```ts
const handleKindChange = (kind: 'event' | 'reminder') => {
  setActiveKindFilter(prev => {
    const next = new Set(prev)
    next.has(kind) ? next.delete(kind) : next.add(kind)
    if (next.has('reminder')) setActiveStatusFilter(new Set())
    return next
  })
}

const handleStatusChange = (status: EventStatus) => {
  setActiveStatusFilter(prev => {
    const next = new Set(prev)
    next.has(status) ? next.delete(status) : next.add(status)
    return next
  })
}
```

When 'reminder' is added to the kind set, the status filter is reset to empty (since reminders don't have meaningful statuses).

## Filter Logic

```ts
const filteredEvents = events
  .filter((e) => activeKindFilter.size === 0 || activeKindFilter.has(e.event_kind as 'event' | 'reminder'))
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
  .filter((e) => activeKindFilter.has('reminder') || activeStatusFilter.size === 0 || activeStatusFilter.has(e.event_status))
```

Third filter: if 'reminder' is in the kind set, skip status filtering entirely (regardless of whether 'event' is also selected).

## UI — Pill Changes

**KIND_FILTER_PILLS:** Remove `{ kind: 'all' }` entry. Remaining: Events, Reminders.

**STATUS_FILTER_PILLS:** Remove `{ status: 'all' }` entry. Remaining: Going, Interested, Planned, Watching, Missed, Cancelled.

**Active state:** `set.has(value)` instead of `=== value`.

**Disabled state:** Status pills get `disabled` + `opacity-40 cursor-not-allowed pointer-events-none` when `activeKindFilter.has('reminder')`.

**onClick:** Kind pills call `handleKindChange(kind)`. Status pills call `handleStatusChange(status)`.

## Empty State Messages

Use generic message for all multi-select filter combinations:

```
No events match your filters.
```

Hashtag-specific messages are preserved:
- hashtag active → "No events found for #tag in My Plans."

"Clear filters" resets: `activeKindFilter → new Set()`, `activeStatusFilter → new Set()`, `activeHashtag → null`.

## Files Changed

- `src/components/MyFeed.tsx` — state, handlers, filter logic, pill arrays, pill rendering, empty state messages
