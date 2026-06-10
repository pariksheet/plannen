# Schedule page — ranged "This week" + calendar dot cap — design

**Date:** 2026-06-10
**Status:** Approved (design)

> Examples use generic personas ("School run", "Gym"). No personal data — the repo is PUBLIC.

## Problem / gap

The Schedule page (`ScheduleOverview`) has two rough edges:

1. **"This week" always shows the whole current week.** Most of the time the user just wants *today*; the full Mon–Sun agenda is more than they need at a glance, and there's no way to peek at next week.
2. **The compact month calendar caps dots at 5 per kind.** A busy day collapses to "5 dots + overflow" too early; the user wants more density before the "+" kicks in.

## Decisions

1. **"This week" becomes a ranged, Today-first card.** A 3-segment control — `Today` | `This Week` | `Next Week` — sits where the "This week" heading was. The card defaults to **Today** on every mount (not persisted). Tapping a segment switches the range.
   - **Today** (default): only today's bucket, with today's routines folded in by part-of-day (the existing merge).
   - **This Week**: the full current ISO week Mon–Sun — unchanged from today's behaviour (today highlighted, past days dimmed, today's routines folded into the today row).
   - **Next Week**: the next ISO week Mon–Sun, events only.
2. **Routines stay today-only.** Routine rows render only in the bucket whose date equals the real today. So they appear in **Today** and **This Week** (in the today row) and **never in Next Week**. No new routine logic — reuses `useTodayRoutines`.
3. **`buildWeekAgenda` gains an optional `today` argument** so it can build an arbitrary week while computing `isToday`/`isPast` against the real current date. `buildWeekAgenda(events, weekRef, today = weekRef)`. Next Week passes `(events, now+7d, now)`; Today/This Week pass `(events, now)` (unchanged).
4. **Empty-range placeholders.** Today with no events and no routines → "Nothing scheduled today." Next Week with no events → "Nothing scheduled next week."
5. **Calendar dot cap 5 → 11.** `CalendarGrid.tsx` `DOT_CAP` changes from `5` to `11`. Compact day cells render up to 11 dots **per kind** (event/reminder/todo) before the "+" overflow. Semantics and the count-bearing `aria-label` are otherwise unchanged.

## Components

### `buildWeekAgenda(events, weekRef, today?)` — `src/utils/weekAgenda.ts`
- **Change:** add a third optional parameter `today: Date = weekRef`. Build the 7 ISO-week days around `weekRef` (via existing `weekDays(weekRef)`), but compute `todayKey = ymd(today)`, `isToday = dateKey === todayKey`, `isPast = dateKey < todayKey`. The "skip empty non-today buckets" rule is unchanged (uses the new `isToday`).
- **Back-compat:** existing callers passing two args are unaffected (`today` defaults to `weekRef`).

### `WeekCard` — `src/components/ScheduleOverview.tsx`
- **State:** `const [range, setRange] = useState<'today' | 'this-week' | 'next-week'>('today')` — resets to `'today'` each mount.
- **Range → buckets:**
  - `today` → `buildWeekAgenda(events, now).filter((b) => b.isToday)`
  - `this-week` → `buildWeekAgenda(events, now)`
  - `next-week` → `buildWeekAgenda(events, addDays(now, 7), now)` where `addDays` is a small local helper (`const d = new Date(now); d.setDate(d.getDate() + 7); return d`).
- **Header:** replace the `<h3>This week</h3>` with a segmented control rendering three buttons (`Today`, `This Week`, `Next Week`); the active one is highlighted (reuse the card's existing accent classes). Each button calls `setRange(...)`.
- **Rows:** the existing flatten + today-bucket routine-merge logic is unchanged; it operates on the range's buckets. Because routines only merge into the `isToday` bucket, Next Week (no today bucket) shows no routines automatically.
- **Empty range:** if the selected range yields zero rows, render the matching placeholder text ("Nothing scheduled today." / "Nothing scheduled next week." / "Nothing scheduled this week.").

### `CalendarGrid` — `src/components/CalendarGrid.tsx`
- **Change:** `const DOT_CAP = 11` (was `5`). One line. The comment above it stays accurate ("Max dots rendered per kind in a compact cell before showing a '+' overflow.").

## Data flow

`WeekCard` already receives `events` and uses `useNow()` + `useTodayRoutines(todayIso())`. The only new input is the local `range` state, which selects which `buildWeekAgenda(...)` call feeds the existing row builder. No new fetches, services, or props.

## Edge cases

- **Range = today, nothing today** → today's bucket exists (isToday always kept) but has no events; if there are also no routines, show "Nothing scheduled today."
- **Range = next-week, no events** → `buildWeekAgenda` skips all empty non-today buckets and next week has no today → empty array → "Nothing scheduled next week."
- **A recurring event** (has `recurrence_rule`) is skipped by `buildWeekAgenda` today; that behaviour is unchanged for all ranges.
- **DOT_CAP**: a day with >11 of a kind still shows the "+" overflow; `aria-label` carries the true counts (unchanged).

## Testing

- `weekAgenda.test.ts` — new case for the `today` overload: `buildWeekAgenda(events, nextWeekRef, now)` yields buckets all with `isToday === false` and `isPast === false`, scoped to next week's dates; the two-arg form is unchanged.
- `ScheduleOverview.test.tsx` —
  - defaults to **Today**: only today's items render (an event on a different day this week is absent until "This Week" is tapped);
  - tapping **This Week** reveals the other day's event;
  - tapping **Next Week** shows a next-week event and renders **no** routine rows;
  - a routine still folds into the Today view and toggling it still calls `markPracticeDone`/`unmarkPracticeDone`.
- `CalendarGrid` test (if one exists) — a day with 7 events of one kind renders 7 dots (previously capped at 5); a day with 12 renders 11 + the "+" overflow. If no calendar dot test exists, add a focused one.
- Full web suite stays green; no engine/MCP/parity surface touched.

## Out of scope (YAGNI)

- Persisting the selected range across reloads (always defaults to Today).
- Arbitrary week navigation beyond Today / This Week / Next Week (no date picker here — the month calendar already covers browsing).
- Changing dot colours, sizes, or the non-compact calendar rendering.
- Any change to routines, attendances, obligations, Overdue, or This Month list behaviour.
