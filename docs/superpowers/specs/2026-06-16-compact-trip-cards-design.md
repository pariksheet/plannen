# Compact, expandable trip cards

**Date:** 2026-06-16
**Scope:** `src/components/TripsSection.tsx` only (no data/service changes).

## Problem

Inside the "Trips" section, each trip currently renders an always-on stack:
title + date + share/edit/delete buttons, a separate `Events (N)` expander, and
the checklist rows always visible below. The result is tall and noisy when a user
has several trips. We want each trip to read as a **compact card** that expands
inline to reveal its events and checklist together.

## Behaviour

### Collapsed (default)

Each trip is a compact card showing, in one header row:

- Title (truncated) and date range (`27 Jun – 21 Jul 2026`).
- The existing share / edit / delete action buttons — **always visible**.
- A chevron (`ChevronDown` / `ChevronUp`) that toggles the expanded view.

Below the header, a single muted **summary line**:

- Events: `N events` (singular `1 event`); omitted when the trip has no children.
- Checklists: exactly one → `checklist d/t`; more than one → `M checklists`;
  omitted when the trip has none.
- Parts joined with ` · `. When a trip has neither events nor checklists, show a
  muted `Empty`.

Example: `4 events · checklist 2/10`.

### Expanded

Toggled by the chevron only (the card body is not a click target). Reveals,
inline and **flat** (no intermediate `Events (N)` button):

1. The `EventList` for the trip's children, rendered directly with the same
   props as today (`viewMode="compact"`, `showActions`, `showWatchButton={false}`,
   etc.). When the trip has no children, show the existing
   "Nothing in this trip yet…" note instead.
2. The checklist rows (`checklistsOf`) and the `+ Checklist` button, unchanged
   from today, below the events.

## Implementation notes

- The per-trip `openEvents` state map is repurposed as a single per-trip
  `expanded` map controlling the whole reveal (events + checklist). Rename for
  clarity (`openEvents` → `expanded`).
- The section-level `open` toggle (outer "Trips" card) is unchanged.
- The `Events (N)` button (current lines ~125–133) is removed; its chevron role
  moves to the card-header chevron.
- The checklist block moves inside the `expanded` conditional (it is no longer
  always visible).
- A small helper builds the summary string from `childrenOf(t.id)` and
  `checklistsOf?.(t.id)`. Checklist counts aggregate `done`/`total` only for the
  single-checklist case; multi-checklist shows the count of checklists.

## Out of scope

- `EventList.tsx` and its own nested container expander (`openTrips`) — untouched.
- Any data, service, or schema change.
- Behaviour of the outer "Trips" section collapse.

## Testing

- Trip with events + one checklist → summary `N events · checklist d/t`;
  expanding shows the event list then the checklist; collapsing hides both.
- Trip with events only → summary `N events`; no checklist block when expanded
  unless `onCreateChecklist` is provided (then only the `+ Checklist` button).
- Trip with no events and no checklists → summary `Empty`; expanding shows the
  "Nothing in this trip yet…" note.
- Chevron toggles; action buttons remain clickable in the collapsed state and do
  not toggle expansion.
