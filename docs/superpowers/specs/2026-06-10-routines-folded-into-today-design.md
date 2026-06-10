# Routines folded into Today — design

**Date:** 2026-06-10
**Status:** Approved (design)

> Examples use generic personas/routines ("Vitamins", "Gym", "School run"). No personal data — the repo is PUBLIC.

## Problem / gap

Routines (practices) render in a **dedicated section** on two surfaces:

- `ScheduleOverview` (the MyFeed "Schedule" view) has a standalone `RoutinesCard` listing all active practices, separate from the "This week" agenda.
- `Today.tsx` (the Dashboard "Today" view) has a standalone "Practices" section listing **all** active practices, separate from the briefing.

A dedicated section reads as a disconnected to-do dump: it shows routines that aren't relevant today (a monthly routine, a flex routine already at target), and it sits apart from the day's actual events. The user wants routines **folded into the day** — appearing inline in "This week"/"Today" only when applicable for today, with no dedicated section.

## Decisions

1. **No dedicated routines section on either surface.** `RoutinesCard` is removed from `ScheduleOverview`; the "Practices" section header is removed from `Today.tsx`.
2. **Only today-applicable routines appear.** A routine shows for today iff `isPracticeDueOn(practice, today, completions)` — i.e. a **pinned** routine whose cadence fires today, or a **flex** routine still under its weekly/monthly target. (Reuses the existing pure logic in `src/utils/scheduling.ts` / `practiceLabel.ts`; no new due-logic.)
3. **Done routines stay, checked off.** Ticking a routine marks it done for today; the row remains visible (checkbox checked / struck-through, like a completed todo) so it can be seen and unticked. A flex routine shows its updated progress (`1/3 → 2/3`) and remains until its period target is met, after which it drops off on the next render.
4. **Interleave by part-of-day.** Routines carry a coarse `preferred_time_of_day` (morning/afternoon/evening/anytime), not a clock time. Each routine gets a synthetic sort key so it sorts among the day's timed items: morning→480, afternoon→780, evening→1080, anytime→`Number.POSITIVE_INFINITY` (sorts last). In `ScheduleOverview`'s "This week" today bucket, routine rows merge with the day's event rows by this key; in `Today.tsx` (which has no timed events) routines simply order by the key.
5. **Shared logic in one hook.** A new `useTodayRoutines(date)` hook owns fetch → filter → toggle, so both surfaces stay in sync and the duplicated fetch logic (previously in `RoutinesCard` and `Today.tsx`) collapses to one place.

## Components

### `useTodayRoutines(date)` — new shared hook (`src/hooks/useTodayRoutines.ts`)
- **Does:** fetches active practices + this-period completions via `dbClient`, filters to `isPracticeDueOn(p, date, completions)`, returns the applicable rows + a toggle.
- **Returns:** `{ routines: TodayRoutine[]; toggle: (id: string) => Promise<void>; loading: boolean }` where
  ```ts
  type TodayRoutine = {
    id: string
    label: string        // practiceLabel(p, periodDone) — "Vitamins (daily)", "Gym (1/3 this week)"
    done: boolean        // completed today
    sortMins: number     // part-of-day key (480/780/1080/∞)
  }
  ```
- **Depends on:** `dbClient.practices` (existing list + completions + markDone/unmarkDone), `isPracticeDueOn`/`practiceLabel`/`doneThisPeriod` (existing utils), the period-window completions fetch (earlier of week-start and month-start, same as Phase 1).
- **Sort key helper** `partOfDayMins(tod)` lives in a small pure util (`src/utils/routineOrder.ts`) so it's unit-testable: `morning→480, afternoon→780, evening→1080, anytime→Number.POSITIVE_INFINITY`.

### `ScheduleOverview` changes
- Delete `RoutinesCard` and its render slot (and the "+N more in Routines" overflow line — no Routines section to point at).
- `WeekCard` consumes `useTodayRoutines(today)`. When flattening day buckets into rows, the **today bucket** produces a merged, sorted row list of its events **and** routine rows (keyed by `sortMins`; events use their existing time-derived minutes, date-only/todo events keep their current ordering position, routines slot by part-of-day). A new `WeekRow` variant `{ kind: 'routine', ... }` renders a checkable row (checkbox + label, struck when `done`) inside today's highlighted group, styled consistently with the todo rows already there. Non-today buckets are unchanged.

### `Today.tsx` changes
- Remove the `<section>` "Practices" header and its all-practices list.
- Render the `useTodayRoutines(today).routines` (ordered by `sortMins`) folded under the Briefing as plain checkable rows — only today-applicable, no section label. Empty → render nothing.

## Data flow

`useTodayRoutines(date)` → `dbClient.practices.list()` + `dbClient.practices.completions(periodFrom)` → filter `isPracticeDueOn` → map to `TodayRoutine` (label via `practiceLabel`, `sortMins` via `partOfDayMins`). `toggle(id)` → `markDone`/`unmarkDone` → refetch completions. Surfaces read `routines`, sort/merge by `sortMins`, render checkable rows; the checkbox calls `toggle`.

## Edge cases

- **No applicable routines** → the hook returns `[]`; neither surface renders any routine UI (no empty section).
- **Flex routine ticked** → completion logged; progress label updates (`practiceLabel` recomputes `1/3 → 2/3`); row stays until `isPracticeDueOn` flips false (target met), then absent next render.
- **Pinned routine ticked** → stays checked; untick restores (idempotent mark/unmark already exists).
- **Month-period flex routine** → completions window already widened to month-start (Phase 1 logic) — reuse it so the count is correct.

## Testing

- `routineOrder.test.ts` — `partOfDayMins` mapping for all four values.
- `useTodayRoutines` test — filters to today-applicable (pinned-due + flex-under-target, excludes a met-target flex and an off-cadence pinned), maps label + done + sortMins, toggle flips done. (Mock `dbClient`.)
- `ScheduleOverview.test.tsx` — updated: `RoutinesCard` gone; a today-applicable routine renders inside the "This week" today group as a checkable row, ordered by part-of-day; ticking calls the toggle; a non-applicable routine is absent.
- `Today.tsx` test — "Practices" header gone; today-applicable routines render folded; all-practices-regardless behavior removed.
- Full web suite stays green; no change to the pure scheduling/recurrence engine (so engine-parity guard is untouched).

## Out of scope (YAGNI)

- Routines on **future** days of the week (only today folds in).
- A routine create/edit UI (creation stays agent-driven).
- Re-ordering or grouping beyond the part-of-day key (no drag, no custom priority).
- Any change to attendances/obligations rendering (`TodayScheduleCard` is unrelated and stays).
