# Calendar View — My Feed Integration Design

**Date:** 2026-05-06
**Status:** Approved

## Overview

Replace the standalone "My Calendar" nav tab with a Calendar view mode inside My Feed. The view toggle becomes Compact | Detailed | **Calendar**. All existing filters (kind, status, hashtag) apply to the calendar. Fix a bug where recurring parent events span their full date range instead of showing individual child sessions on their specific dates.

## Architecture

### New component: `CalendarGrid`

`src/components/CalendarGrid.tsx` — pure display component, no data fetching.

```ts
interface CalendarGridProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onEdit?: (event: Event) => void
  onDelete?: (eventId: string) => void
  onShareSuccess?: () => void
}
```

Owns internal UI state only: `currentMonth`, `selectedDate`, monthly/weekly sub-toggle, focused event modal. Computes `eventsByDay` from props.

Extracted and fixed from the existing `MyCalendar.tsx`.

### MyFeed changes

- `EventViewMode` type extended to `'compact' | 'detailed' | 'calendar'`
- View toggle gets a third button: Compact | Detailed | Calendar
- When `viewMode === 'calendar'`: render `<CalendarGrid events={filteredEvents} preferredVisitDates={preferredVisitDates} />`
- Filters apply automatically — CalendarGrid receives whatever MyFeed has already filtered
- `localStorage` key `timelineViewMode` saves/restores all three modes (add `'calendar'` as valid value)

### Navigation cleanup

- Remove "My Calendar" tab from `Navigation.tsx` (`View` type loses `'calendar'`, `CalendarDays` icon removed)
- Remove `{currentView === 'calendar' && <MyCalendar />}` from `Dashboard.tsx`
- Delete `src/components/MyCalendar.tsx`

## Session fix

**Problem:** A recurring parent event (e.g. "Swimming lessons", Mar 1 – Jun 30) gets plotted across every day in its date range. Child sessions (individual occurrences with `event_kind = 'session'` and `parent_event_id`) should appear on their own dates instead.

**Fix in `eventsByDay`:**

```ts
const parentIds = new Set(
  events.filter(e => e.parent_event_id).map(e => e.parent_event_id!)
)

for (const event of events) {
  if (parentIds.has(event.id)) continue  // skip parent; sessions handle it
  if (event.event_kind === 'session') {
    // plot on start_date only — sessions are always single-day occurrences
    const key = toDateKey(startOfDay(new Date(event.start_date)))
    // ... add to byDay map
    continue
  }
  // existing logic for regular events (single-day or multi-day span)
}
```

## Files Changed

| Action | File |
|--------|------|
| Create | `src/components/CalendarGrid.tsx` |
| Modify | `src/types/event.ts` — add `'calendar'` to `EventViewMode` |
| Modify | `src/components/MyFeed.tsx` — third view mode button, render CalendarGrid |
| Modify | `src/components/Navigation.tsx` — remove calendar tab |
| Modify | `src/pages/Dashboard.tsx` — remove MyCalendar render |
| Delete | `src/components/MyCalendar.tsx` |
