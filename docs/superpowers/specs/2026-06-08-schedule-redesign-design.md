# Schedule page redesign — design

**Date:** 2026-06-08
**Status:** Approved (brainstorm)
**Scope:** The "Schedule" view of the web app (`MyFeed` → `ScheduleOverview`). Timeline and Calendar view-modes are untouched.

## Goal

Replace the four stacked cards (Routines · Today · This Week · This Month) with a tighter layout that:

1. Never wastes half-width space on a sparse Today next to a full This Week.
2. Shows dates on every row.
3. Treats reminders consistently.
4. Sources weather from the user's real location instead of a hard-coded city.
5. Makes a clicked event open the same rich card the Timeline uses — with edit / delete / actions.

No DB or schema changes. No changes to the Timeline or Calendar view-modes.

## Current state (for reference)

- `src/components/ScheduleOverview.tsx` renders, top to bottom: `HeaderStrip`, `RoutinesCard`, a 2-col grid of `TodayCard` + `ThisWeekCard`, then `ThisMonthCard`. On click it opens `EventDetailsModal` directly.
- `TodayCard` and `ThisWeekCard` sit in a CSS grid row, so a 1-item Today stretches to the height of a 10-item This Week, leaving a tall empty half-width box.
- Reminder visibility is inconsistent: **Today** shows reminders (no kind filter in `isTodayStrict`), **This Week** shows them but hides *past* ones (`buildWeekList`), **This Month** excludes them entirely (`isInMonthList`).
- `HeaderStrip` calls `getTodayWeather('Brussels')` with a string literal — no wiring to the user's location. The weather service already maps Brussels/Antwerp/Ghent/Leuven to coordinates.
- Clicking opens the full `EventDetailsModal`, which exposes only **Edit** (pencil). There is **no Delete** wired into it, and it is heavy (description, registration, sharing, hashtags, RSVP list, memories, story).
- The Timeline tab renders each event via `EventCard` in `compact` viewMode — a self-contained card that already carries inline actions (edit pencil, a kebab with Delete / Clone / Download .ics / Google Calendar / Outlook, swipe-to-RSVP on mobile) and opens `EventDetailsModal` on tap.

## New structure

```
HeaderStrip        (date + weather — weather becomes location-aware)
RoutinesCard       (unchanged)
WeekCard           (NEW — folds Today into a day-grouped week)
ThisMonthCard      (unchanged: CalendarGrid + sidebar)
```

`TodayCard` and `ThisWeekCard` are deleted and replaced by a single `WeekCard`. `buildWeekList` (day-chip recurrence collapsing) is retired.

## WeekCard

- Renders the current week **Mon → Sun**, grouped by day. Each day shows its **weekday label + date number** (e.g. "Wed 4").
- **Today's day-block is highlighted** with a dashed amber band and amber day-head text. The old standalone yellow Today card is gone; "today" is now just the highlighted band inside the week.
- **Earlier days in the week stay visible, dimmed** (~55% opacity).
- Rows are thin **time + title** lines (a scannable agenda, not cards).
- **Within today's block**, the existing `eventTimeState(event, now)` logic applies, scoped to today:
  - `past` → strike-through, grey, checkbox checked.
  - `now` → bold, `→` arrow indicator.
  - `upcoming` → normal.
  - Live-updates once a minute via the existing `useNow()` hook.
- Days other than today render their rows in normal (or, for past days, dimmed) styling without the now/past/upcoming per-row treatment — that distinction only matters for today.
- **Empty days:** always render today's block even when empty (with a friendly "Nothing scheduled — enjoy the day." line, matching the old Today card); omit other empty days entirely so the list stays short.
- **Reminders**: every reminder whose date falls in the Mon–Sun window renders as an inline row with a small `reminder` tag, **including past ones**. This drops the current "hide past reminders" filter. Rule: *the week shows all reminders in range, tagged.* (The month list deliberately continues to exclude reminders — an existing, intentional noise-reduction choice, now documented rather than accidental.)
- **Recurrence**: because rows are grouped by actual day, each concrete session appears under its own day. The old `buildWeekList` collapsing of a series into one "Mon, Wed, Fri" chip row is retired. Recurrence *parents* (`recurrence_rule` set) remain hidden; *sessions* (`parent_event_id` set) show on their day, matching current parent/session handling.
- Date handling reuses the existing helpers (`eventDateLocal`, `ymd`, `timeOf`): date-only ISO strings are local all-day; timestamps convert to the local date.

## Click → reused EventCard (option A: thin agenda + card on click)

- Clicking any WeekCard row (and any ThisMonthCard list/sidebar row) opens the existing **`EventCard` in `compact` viewMode** — the same component the Timeline renders — wired with `onEdit`, `onDelete`, `onShareSuccess`, `onHashtagClick`, `showActions`, `showRSVP`.
- Presentation via a small new wrapper, `QuickEventCard`:
  - **Desktop:** the card appears inline, directly beneath the clicked row.
  - **Phone:** the card slides up as a bottom sheet.
  - Only one quick-card is open at a time.
- Full details (`EventDetailsModal`) remain one tap deeper — `EventCard` already opens it on card tap.
- This **removes** `ScheduleOverview`'s direct `EventDetailsModal` usage and its `focusedEvent` / `rsvpVersion` state. Delete (previously missing) plus all calendar/clone actions come for free from `EventCard`.

## Weather location

- `HeaderStrip` stops passing the literal `'Brussels'`.
- It reads the **default `user_location.city`** via `getLocations()` from `profileService` (the `UserLocation` whose `is_default` is true). This is the structurally-correct "home location" — a refinement on the original "profile fact" idea, reusing existing data instead of a new free-form fact.
- **Fallbacks:** if no default location is set, or the city is not one of the four the weather service maps (Brussels / Antwerp / Ghent / Leuven), fall back to `'Brussels'`. The service already defaults unmapped cities to Brussels coordinates, so passing an unmapped city is safe; we pass the city string through and let the service resolve it.
- Extending the supported-city list or adding geocoding is a noted follow-up, out of scope here.

## Components

- **Rewrite:** `src/components/ScheduleOverview.tsx` — add `WeekCard`; delete `TodayCard`, `ThisWeekCard`, `buildWeekList`, `WeekListEntry`; replace the click handler with the `QuickEventCard` reveal; update `HeaderStrip` weather wiring.
- **New (small):** `QuickEventCard` reveal wrapper (bottom-sheet on mobile / inline on desktop) hosting a `compact` `EventCard`. May live in its own file or inside `ScheduleOverview.tsx`.
- **Reuse as-is:** `EventCard`, `EventDetailsModal`, `RoutinesCard`, `ThisMonthCard`, `CalendarGrid`, `getLocations`.
- **Props:** `ScheduleOverviewProps` is unchanged (`events`, `preferredVisitDates`, `onEdit`, `onDelete`, `onShareSuccess`, `onHashtagClick`) — `MyFeed` already passes everything `EventCard` needs.

## Testing

- `WeekCard` grouping: events bucket into the correct Mon–Sun day; today's block is flagged; past days are dimmed; a date-only event lands on its local day.
- Reminder rule: a past reminder in the week renders with the tag (previously hidden); a reminder outside the week does not appear.
- Today block: `eventTimeState` transitions (past / now / upcoming) render the right affordance; `useNow` re-render keeps it live.
- Click reveal: clicking a row opens exactly one `QuickEventCard` with `onDelete` present; clicking another row moves the reveal; the card's own tap still opens `EventDetailsModal`.
- Weather: `HeaderStrip` requests the default location's city; falls back to Brussels when no default exists.
- Follow existing test isolation conventions (tmp dirs / no real FS or network in unit tests; mock `getLocations` and `getTodayWeather`).

## Out of scope

- Timeline and Calendar view-modes.
- `ThisMonthCard` / `CalendarGrid` internals (only their row-click target changes to the shared reveal).
- Extending supported weather cities or adding geocoding.
- Any DB / schema / migration change.
