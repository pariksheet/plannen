# Schedule overview — design

Date: 2026-05-28
Status: approved, ready for implementation plan

## Goal

Add a **Schedule** view-mode to the My Plans tab that renders a synthesised dashboard (header, weather, routines, today, this week, this month) instead of the linear event list. It becomes a third pill in the existing view-mode toggle, sitting to the left of Timeline (the renamed Compact) and Calendar.

The view answers "what's my day / week / month look like at a glance?" in one screen, pulling from the events already fetched by `MyFeed`, the practices service, and a new lightweight weather service.

## Scope

In scope:
- New `'schedule'` value on the `EventViewMode` type.
- New `ScheduleOverview` component rendered when `viewMode === 'schedule'`.
- New `weatherService.ts` (meteo.be) — fetch + session-cache + graceful failure.
- Reuse of existing services for practices, events, and the primary group.

Out of scope (deferred):
- Per-user weather location setting (v1 uses primary group's location or a Brussels fallback).
- (none — Schedule is the default for new users; existing users keep their saved `compact`/`calendar` choice via localStorage.)
- Drag/drop reordering, inline event creation from the overview.
- Tier 0 social differences beyond what's already in place — the family-tag line just hides when no primary group exists.

## Placement and navigation

`MyFeed.tsx` already has a view-mode pill row that switches between Timeline (key `compact`) and Calendar (key `calendar`). We add a third pill **before** Timeline:

```
[ Schedule | Timeline | Calendar ]
```

- Add `'schedule'` to `EventViewMode` in `src/types/event.ts`.
- Update the localStorage hydrator in `MyFeed.tsx` to accept `'schedule'` alongside `'calendar'` and fall back to `'compact'` otherwise.
- When `viewMode === 'schedule'`, the existing `<Timeline … />` / `<CalendarGrid … />` block is replaced by `<ScheduleOverview events={events} … />`.

**Schedule is the default view-mode for My Plans.** Users who have never picked a mode (no `timelineViewMode` key in localStorage) land on Schedule. Existing users with a saved `compact` or `calendar` choice keep their preference. The hydrator's fallback changes from `'compact'` → `'schedule'`.

## Component layout

A single new component: `src/components/ScheduleOverview.tsx`.

Receives the already-fetched `events: Event[]` and the same callbacks (`onEdit`, `onDelete`, `onRsvpChange`, etc.) that `Timeline` consumes today, so clicks open the same `EventForm` modal flow.

Desktop grid (≥ sm breakpoint):

```
┌─ Header strip ───────────────────────────────────────────────┐
│ Your Schedule                                Tue, May 21      │
│                                              for the X family │
├──────────────────────────────────┬───────────────────────────┤
│ Weather                          │ Routines (top right)       │
├──────────────────────────────────┼───────────────────────────┤
│ Today (yellow accent)            │ This week (green accent)   │
├──────────────────────────────────┴───────────────────────────┤
│ This month (purple accent) [grid]            [notable list]   │
└──────────────────────────────────────────────────────────────┘
```

Mobile (< sm): single column in the order Header → Weather → Routines → Today → This week → This month. Each card stays standalone and scroll-friendly.

Tailwind only — no new fonts, no hand-drawn assets. Pastel accents on the Today/Week/Month card backgrounds (subtle tints, not the saturated mockup tones) so the visual hierarchy from the mockup carries over.

## Section-by-section data wiring

### 1. Header strip
- **Title:** static "Your Schedule".
- **Date:** `new Date()` formatted as e.g. "Tue, May 21" with `toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })`.
- **Family tag:** `usePrimaryGroup()` → render `for the {primaryGroup.name} family` when a primary group exists; otherwise omit the line entirely. No new fetch.

### 2. Weather card
New module `src/services/weatherService.ts`:
- `async function getTodayWeather(city: string): Promise<TodayWeather | null>` calling **meteo.be** (RMI).
- Returned shape:
  ```ts
  interface TodayWeather {
    temp_c: number;
    summary: string;          // "Clear all day"
    chips: { label: string; time: string }[];  // AM/noon/PM strips
    fetched_at: string;       // ISO
  }
  ```
- Cache key: `weather:{city}:{ymd}` in `sessionStorage` so a tab swap doesn't re-hit.
- Failure mode: the service returns `null`; the card renders "Weather unavailable" muted text. The rest of the dashboard renders unaffected.

City source for v1:
1. If `primaryGroup` has a `location` string, pass it.
2. Else hardcoded `'Brussels'` fallback.

(Per-user setting is a follow-up. Documented as out of scope above.)

### 3. Routines card
Reuses the same data path as `Today.tsx`:
- `listPractices(true)` from `src/services/practiceService.ts`.
- `completionsThisWeek(weekStart)` for "done" state.
- Toggle via `markPracticeDone` / `unmarkPracticeDone`.

Render:
- Tight list, circular checkbox + label, same `(n/m this week)` suffix logic as `Today.tsx`.
- Cap visible at 6; if more exist, a "+N more" link routes to `view=today` (the existing Today screen which already has the full list).

### 4. Today card (yellow accent)
- Filter the inbound `events` array: keep events where `start_date <= today` and `(end_date ?? start_date) >= today`. Same predicate the timeline already uses for the "today" bucket — extract to a small util if not yet shared.
- Sort by start time.
- Each row: time + title + status pill. Reuses the existing `EventCard` in a compact mode if available; otherwise a minimal inline row. Click → existing `onEdit(event)` callback flow.
- Empty state: "Nothing scheduled — enjoy the day."

### 5. This week card (green accent)
- Compute Mon–Sun window containing today.
- Filter events whose date range intersects that window.
- Render a 7-column header row (Mon Tue … Sun) and a single body row per day with event chips (max 3 chips per cell, "+N" overflow). Today's column gets a subtle highlight.
- Chip click → `onEdit(event)`.
- This is intentionally a **summary** card, not the full week grid. Calendar pill remains the route for the detailed week/month grid.

### 6. This month card (purple accent)
Two-column on desktop, stacked on mobile:
- **Left:** existing `<CalendarGrid />` component in compact size (we pass an explicit `compact` or `size="sm"` prop if needed, otherwise scale via wrapper). Renders the current month with event dots.
- **Right:** sidebar list of "notable" events in the month. A notable event is any of:
  - `event_kind === 'reminder'`, OR
  - `enrollment_deadline` falls within the month, OR
  - `start_date` is the user's own event and includes any `#deadline` hashtag.
  Each row: short date + title. Click → `onEdit(event)`.

## Cross-cutting

- **No new event queries.** The view consumes the same `events` array `MyFeed` already loads. Adding a new view-mode does not add round-trips.
- **New round-trips per visit:** weather (cached for the session) + practices (already cached by `Today.tsx`'s pattern). Total: at most 2 small fetches the first time you open Schedule in a session.
- **Loading state:** while `loading` from `MyFeed` is true, render a skeleton for the whole grid. Weather + practices show inline spinners but don't block the rest.
- **Error surfaces:**
  - Event load error: same banner `MyFeed` already shows.
  - Weather error: "Weather unavailable" in the weather card only.
  - Practices error: "Couldn't load routines" in the routines card only.
- **Mobile breakpoint:** below `sm`, collapse to single column. Each card uses the full row width.
- **Accessibility:** every section has a heading; checkboxes have visible labels; chip buttons have `aria-label="{title} on {date}"`.

## Files touched

New:
- `src/components/ScheduleOverview.tsx` — the new view.
- `src/services/weatherService.ts` — meteo.be fetch + session cache.

Modified:
- `src/types/event.ts` — extend `EventViewMode` with `'schedule'`.
- `src/components/MyFeed.tsx` — third pill, dispatch to `ScheduleOverview`, hydrator update.

No DB changes. No edge function changes. No new MCP tools. No migrations.

## Risks and rollback

- **meteo.be format change** — the weather card degrades to "Weather unavailable" automatically; no other view is affected. A small `try/catch` around the parser is sufficient.
- **CalendarGrid layout** — if the compact size prop doesn't render cleanly inside the month card, fall back to a CSS-scaled wrapper (`transform: scale()`); acceptable for v1.
- **Rollback:** the change is purely additive (a new view-mode value + a new component + a new service). Reverting the `MyFeed.tsx` and `event.ts` edits removes the pill and the rest is dead code with no production touch.

## Testing plan

- Existing `MyFeed` tests stay green; add a render test that confirms `ScheduleOverview` mounts when `viewMode === 'schedule'`.
- `weatherService` unit test: happy path (parse fixture), failure path (network error → `null`), cache hit (no second fetch).
- `ScheduleOverview` snapshot/render test with a fixed `events` array covering: today + this-week + this-month + empty states.
- Manual: open My Plans → Schedule → verify each card renders, weather hits meteo.be once per session, routines toggle, event clicks open the edit modal.
