# Starred-group Schedule view — design

**Date:** 2026-06-16
**Status:** Approved

## Problem

The personal feed ("My Plans" / `MyFeed`) offers three views — **Schedule**, **Compact** (Timeline),
and **Calendar** (CalendarGrid). The group view (`MyGroups`) only offers **Compact** and **Calendar**.
The user wants the starred/primary group (in their case "My Family") to present the same three-view
experience, scoped to events shared with that group.

## Decisions (from brainstorming)

1. **Schedule content:** full dashboard layout, group-scoped — Today / Overdue / Week agenda / This-Month.
2. **Whose data feeds it:** derive every section purely from events shared with the group. No separate
   per-member obligation/attendance feed (no new cross-user queries, no new privacy surface).
3. **Default view:** landing on the starred group opens on **Schedule** (matches My Plans).
4. **Which groups:** the Schedule view and the three-way switcher appear **only for the starred/primary
   group**. "All" and non-primary groups keep Compact / Calendar unchanged.

## Approach

Reuse the existing `ScheduleOverview` component (Approach A). It already degrades to a pure
events-derived dashboard:

- `TodayScheduleCard` ("Today on a schedule") renders **only** when `attendancesToday`/`obligationsToday`
  are passed. Omitting them (decision 2) makes it self-hide.
- `OverdueCard`, `WeekCard`, and `ThisMonthCard` derive entirely from the `events` array.

Two personal-leaning details need suppressing in a group context:

- The header reads "Your Schedule" — should read the group name.
- `WeekCard` merges the current user's personal routines via `useTodayRoutines` — must be dropped.

Rejected alternatives: a separate `GroupScheduleOverview` (≈800 lines duplicated, drifts from the
personal Schedule), and extracting a shared `ScheduleBoard` (cleanest long-term but a larger refactor
than this task warrants).

## Changes

### `src/components/ScheduleOverview.tsx`

Two optional, backward-compatible props:

- `heading?: string` (default `"Your Schedule"`) — `HeaderStrip` renders this instead of the hardcoded
  label. The starred-group view passes the group name.
- `hideRoutines?: boolean` (default `false`) — when true, `WeekCard` skips the routines merge (the
  `useTodayRoutines` rows). Existing callers (MyFeed) pass neither prop and are unaffected.

### `src/components/MyGroups.tsx`

- **Group-aware toggle.** Compute `isPrimarySelected = !!primaryGroupId && selectedGroupId === primaryGroupId`.
  When true, render three buttons (Schedule / Compact / Calendar); otherwise the existing two.
- **Default to Schedule on the starred group.** An effect keyed on `selectedGroupId` + `primaryGroupId`:
  if `isPrimarySelected`, set `viewMode` to `'schedule'`; otherwise, if the current mode is `'schedule'`,
  fall back to the saved compact/calendar value. This gives "Schedule by default" each time the starred
  group is opened while still allowing in-visit switching.
- **localStorage hygiene.** The `viewMode → timelineViewMode` persistence effect must **not** write
  `'schedule'` (the key is shared with `Timeline`). Guard it to persist only `'compact'`/`'calendar'`.
- **Render.** When `viewMode === 'schedule'` (only reachable for the starred group), render:
  ```tsx
  <ScheduleOverview
    events={filteredEvents}
    preferredVisitDates={preferredVisitDates}
    heading={selectedGroupName ?? 'Schedule'}
    hideRoutines
    onEdit={handleEdit}
    onDelete={/* refresh-wrapping delete */}
    onShareSuccess={refresh}
    onHashtagClick={(tag) => { setActiveHashtag(tag); setShowPast(true) }}
  />
  ```
  `filteredEvents` is already scoped to the selected group, so no new data fetching.

## Non-goals / guarantees

- No MCP / edge-function / scheduling-engine changes — web-only, so no tri-runtime parity concern.
- No new DB queries, no cross-user data access.
- Non-primary groups and "All" render exactly as before.
- `MyFeed` (personal Schedule) is untouched in behaviour — new `ScheduleOverview` props default to today's
  behaviour.

## Testing

- `ScheduleOverview`: renders custom `heading`; omits routines when `hideRoutines` is set; unchanged when
  props are absent.
- `MyGroups`: shows the Schedule toggle and defaults to it only when the starred group is selected; hides
  it (and clamps `'schedule'` → compact/calendar) for "All" / non-primary groups; never persists
  `'schedule'` to localStorage.
- Typecheck + existing component test suite stay green.
