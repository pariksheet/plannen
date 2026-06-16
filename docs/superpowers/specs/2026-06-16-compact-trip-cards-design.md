# Uniform trip cards (render trips through EventCard)

**Date:** 2026-06-16
**Scope:** `src/components/TripsSection.tsx`, `src/components/EventList.tsx`,
`src/components/EventCard.tsx`.

## Problem

In the "Trips" panel each trip was **hand-rolled markup** inside `TripsSection`
(title, date, action buttons, summary line), styled to *resemble* an event card.
It never matched the Watching panel — whose items render through the shared
`EventCard` (status badge, date-with-icon, location pin, hashtag chips, standard
action-icon row). The two were different code paths, so visual drift was
inevitable. The goal is **one uniform UI**: a trip must look like any other event
card because it *is* one.

## Approach

`TripsSection` delegates rendering to the shared `<EventList>` — exactly like the
Watching panel — passing `childrenOf` so each trip is an `EventCard` with the
built-in "Events (N)" expander for its children. Trip-specific behaviour rides on
callbacks instead of bespoke chrome.

## Changes

### `EventCard`
- `onShareSuccess` now receives the shared `event` (`(event: Event) => void`),
  so a parent can react per-event. Existing `() => void` callers remain
  assignable (no breakage).

### `EventList`
- New optional `renderItemFooter?: (event: Event) => ReactNode`, rendered beneath
  each **top-level** card only (not threaded into expanded children). Used for a
  trip's checklist.
- `onShareSuccess` widened to `(event: Event) => void` and threaded through.

### `TripsSection`
- Renders `<EventList events={trips} childrenOf={childrenOf} … />` inside the
  existing collapsible "Trips" panel header. No more hand-rolled card markup.
- **Delete** (`onDelete`) distinguishes by id: a trip id → `deleteContainer`
  (children stay, with the same confirm copy); any other id → `onDeleteEvent`.
- **Share cascade** (`onShareSuccess`): when the shared event is one of the
  trips, `syncTripSharing(trip.id, childIds)` pushes the trip's new audience onto
  its children, then reload. Fires only for the trip, never for a child shared on
  its own.
- **Checklist** renders via `renderItemFooter` — the checklist rows and the
  `+ Checklist` button beneath each trip card; `+ Checklist` opens
  `ChecklistCreateForm` as before.

## Removed

- The hand-rolled per-trip card, its bespoke share/edit/delete buttons, the
  `EventShareModal` wiring inside `TripsSection`, and the `openEvents`/`expanded`
  state (the expander is `EventList`'s own).
- The `tripSummary` helper + test (the summary line is replaced by the standard
  `EventCard` content and the "Events (N)" expander).

## Out of scope

- The Timeline view (`Timeline.tsx`) — a follow-up could thread `childrenOf`
  there too for the same expander, but it is not part of this change.
- Any data, service, or schema change.

## Testing

- `ScheduleOverview.test.tsx` pinned-trips: trip renders through (mocked)
  `EventCard`; the edit action is the standard "Edit event" control and fires
  `onEdit` with the trip.
- Full suite green (`npx vitest run`), `tsc --noEmit` clean, eslint 0 errors.
- Manual: trip card is visually identical to Watching cards; "Events (N)" expands
  children; checklist shows beneath; deleting a trip keeps its children; sharing a
  trip cascades to children.
