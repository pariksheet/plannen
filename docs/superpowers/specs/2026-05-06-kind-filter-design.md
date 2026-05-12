# Kind Filter for MyFeed

**Date:** 2026-05-06  
**Status:** Approved

## Overview

Add event-kind filter pills (All / Events / Reminders) to the MyFeed feed. Pills appear to the left of the existing status pills in the same scrollable row. Selecting "Reminders" disables the status pills, since reminders don't have meaningful statuses.

## State

One new state variable in `MyFeed`:

```ts
const [activeKindFilter, setActiveKindFilter] = useState<'all' | 'event' | 'reminder'>('all')
```

## Filtering Logic

```ts
const filteredEvents = events
  .filter((e) => activeKindFilter === 'all' || e.event_kind === activeKindFilter)
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
  .filter((e) => activeKindFilter === 'reminder' || activeStatusFilter === 'all' || e.event_status === activeStatusFilter)
```

When switching to `'reminder'`, reset `activeStatusFilter` to `'all'` before setting the kind.

## UI

### Kind pills

Three pills prepended to the existing scrollable filter row:

| Label | Active color | Inactive style |
|-------|-------------|----------------|
| All | gray-800 bg | gray border, gray text |
| Events | indigo-600 bg | indigo border, indigo text |
| Reminders | purple-600 bg | purple border, purple text |

Same pill shape/size as status pills (`rounded-full`, `px-3 py-1.5`, `text-xs font-medium border`).

### Status pills when kind = reminder

Apply `opacity-40 pointer-events-none` to the status pills container — visually dimmed, non-interactive.

## Empty State Messages

| Kind | Hashtag | Status | Message |
|------|---------|--------|---------|
| reminder | — | — | "No reminders found." |
| reminder | set | — | "No reminders found for #tag." |
| event | — | set | "No {status} events found." |
| all | set | set | existing behavior |
| all | set | — | existing behavior |

"Clear filters" resets all three: `activeKindFilter → 'all'`, `activeStatusFilter → 'all'`, `activeHashtag → null`.

## Files Changed

- `src/components/MyFeed.tsx` — state, filter logic, pill rendering, empty state messages
