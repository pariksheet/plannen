# Routines Folded Into Today — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dedicated routines sections from both the Schedule view and the Today dashboard, and fold today-applicable routines inline into "This week"/"Today", interleaved by part-of-day.

**Architecture:** A pure util (`routineToday.ts`) decides which routines apply today and computes their part-of-day sort key, composed from the existing web utils `occursOn` (`src/utils/scheduling.ts`) and `doneThisPeriod` (`src/utils/practiceLabel.ts`). A thin `useTodayRoutines(date)` hook fetches practices + completions and returns the applicable rows + a toggle. `ScheduleOverview`'s `WeekCard` merges routine rows into the today bucket; `Today.tsx` renders them folded under the Briefing. The dedicated `RoutinesCard` and the Today "Practices" section are deleted.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, the existing `practiceService` + `dbClient`.

**Design:** `docs/superpowers/specs/2026-06-10-routines-folded-into-today-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/utils/routineToday.ts` | Pure: `partOfDayMins`, `isRoutineApplicableToday`, `applicableTodayRoutines`, type `TodayRoutine` | Create |
| `src/utils/routineToday.test.ts` | Tests for the pure util | Create |
| `src/hooks/useTodayRoutines.ts` | Thin hook: fetch practices+completions → applicable rows + toggle | Create |
| `src/components/Today.tsx` | Replace "Practices" section with folded routine rows | Modify |
| `src/components/ScheduleOverview.tsx` | Delete `RoutinesCard`; interleave routines into `WeekCard` today bucket | Modify |
| `src/components/ScheduleOverview.test.tsx` | Update: RoutinesCard gone; routines fold into "This week" today | Modify |

---

## Task 1: Pure `routineToday` util (filter + sort key)

**Files:**
- Create: `src/utils/routineToday.ts`
- Create: `src/utils/routineToday.test.ts`

- [ ] **Step 1: Write the failing tests** — `src/utils/routineToday.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { partOfDayMins, isRoutineApplicableToday, applicableTodayRoutines } from './routineToday'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'

const base = {
  id: 'p', user_id: 'u', family_member_id: null, name: 'X',
  category: 'household' as const, dtstart: '2026-06-01', recurrence_until: null,
  preferred_time_of_day: 'anytime' as const, active: true, created_at: '', updated_at: '',
}
// 2026-06-10 is a Wednesday; ISO week starts Mon 2026-06-08.
const WED = '2026-06-10'
const WEEK_START = '2026-06-08'

describe('partOfDayMins', () => {
  it('maps each part of day to a sort key', () => {
    expect(partOfDayMins('morning')).toBe(480)
    expect(partOfDayMins('afternoon')).toBe(780)
    expect(partOfDayMins('evening')).toBe(1080)
    expect(partOfDayMins('anytime')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('isRoutineApplicableToday', () => {
  it('pinned daily routine fires today', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(true)
  })
  it('pinned weekly routine NOT firing today is excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'weekly', days: ['MO'] }, flex_period: null, flex_target: null } // Wed != Mon
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('inactive routine excluded', () => {
    const p: PracticeRow = { ...base, active: false, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('pinned past recurrence_until excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, recurrence_until: '2026-06-05',
      flex_period: null, flex_target: null }
    expect(isRoutineApplicableToday(p, WED, [], WEEK_START)).toBe(false)
  })
  it('flex routine under target is applicable', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 3 }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'p', completed_on: '2026-06-08' } as PracticeCompletionRow,
    ]
    expect(isRoutineApplicableToday(p, WED, done, WEEK_START)).toBe(true)
  })
  it('flex routine at target is excluded', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 2 }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'p', completed_on: '2026-06-08' } as PracticeCompletionRow,
      { practice_id: 'p', completed_on: '2026-06-09' } as PracticeCompletionRow,
    ]
    expect(isRoutineApplicableToday(p, WED, done, WEEK_START)).toBe(false)
  })
})

describe('applicableTodayRoutines', () => {
  it('filters, labels, marks done, and sorts by part-of-day', () => {
    const vitamins: PracticeRow = { ...base, id: 'v', name: 'Vitamins',
      recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' },
      preferred_time_of_day: 'morning', flex_period: null, flex_target: null }
    const gym: PracticeRow = { ...base, id: 'g', name: 'Gym',
      recurrence_mode: 'flex_count', recurrence_rule: null,
      preferred_time_of_day: 'anytime', flex_period: 'week', flex_target: 3 }
    const monthly: PracticeRow = { ...base, id: 'm', name: 'Deep clean',
      recurrence_mode: 'pinned', recurrence_rule: { frequency: 'monthly' }, // dtstart day 01, today day 10 → not due
      preferred_time_of_day: 'evening', flex_period: null, flex_target: null }
    const done: PracticeCompletionRow[] = [
      { practice_id: 'g', completed_on: '2026-06-09' } as PracticeCompletionRow, // gym 1/3
      { practice_id: 'v', completed_on: WED } as PracticeCompletionRow,          // vitamins done today
    ]
    const rows = applicableTodayRoutines([gym, vitamins, monthly], done, WED, WEEK_START)
    // monthly (day 01 cadence) not due on day 10 → excluded; gym + vitamins remain.
    expect(rows.map((r) => r.id)).toEqual(['v', 'g']) // morning(480) before anytime(∞)
    expect(rows[0]).toMatchObject({ label: 'Vitamins (daily)', done: true, sortMins: 480 })
    expect(rows[1]).toMatchObject({ label: 'Gym (1/3 this week)', done: false, sortMins: Number.POSITIVE_INFINITY })
  })
})
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `npx vitest run src/utils/routineToday.test.ts`
Expected: FAIL — module `./routineToday` not found.

- [ ] **Step 3: Implement `src/utils/routineToday.ts`**
```ts
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import { occursOn } from './scheduling'
import { practiceLabel, doneThisPeriod } from './practiceLabel'

export type TodayRoutine = {
  id: string
  label: string
  done: boolean
  sortMins: number
}

/** Part-of-day → a synthetic minutes-of-day sort key so routines interleave
 *  among the day's timed items. `anytime` sorts last. */
export function partOfDayMins(tod: PracticeRow['preferred_time_of_day']): number {
  switch (tod) {
    case 'morning': return 480    // 08:00
    case 'afternoon': return 780  // 13:00
    case 'evening': return 1080   // 18:00
    default: return Number.POSITIVE_INFINITY // anytime → end of day
  }
}

/** Is this routine applicable on `date`? Pinned: cadence fires today (active,
 *  within recurrence_until). Flex: still under its period target.
 *  Composed from the existing web utils — behaviourally equal to the server's
 *  isPracticeDueOn without adding a new engine mirror. */
export function isRoutineApplicableToday(
  p: PracticeRow,
  date: string,
  completions: PracticeCompletionRow[],
  weekStart: string,
): boolean {
  if (!p.active) return false
  if (p.recurrence_mode === 'pinned') {
    if (!p.recurrence_rule) return false
    if (p.recurrence_until && date > p.recurrence_until) return false
    return occursOn(p.recurrence_rule, p.dtstart, date)
  }
  // flex_count
  if (p.flex_target == null) return false
  return doneThisPeriod(p, completions, weekStart, date) < p.flex_target
}

/** The today-applicable routines, labelled + done-flagged + sorted by part-of-day. */
export function applicableTodayRoutines(
  practices: PracticeRow[],
  completions: PracticeCompletionRow[],
  date: string,
  weekStart: string,
): TodayRoutine[] {
  return practices
    .filter((p) => isRoutineApplicableToday(p, date, completions, weekStart))
    .map((p) => ({
      id: p.id,
      label: practiceLabel(p, doneThisPeriod(p, completions, weekStart, date)),
      done: completions.some((c) => c.practice_id === p.id && c.completed_on === date),
      sortMins: partOfDayMins(p.preferred_time_of_day),
    }))
    .sort((a, b) => a.sortMins - b.sortMins)
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run src/utils/routineToday.test.ts`
Expected: PASS (3 describe blocks green).

- [ ] **Step 5: Commit**
```bash
git add src/utils/routineToday.ts src/utils/routineToday.test.ts
git commit -m "feat(routines): pure today-applicable filter + part-of-day sort util"
```

---

## Task 2: `useTodayRoutines(date)` hook

**Files:**
- Create: `src/hooks/useTodayRoutines.ts`

- [ ] **Step 1: Implement the hook**

Create `src/hooks/useTodayRoutines.ts`:
```ts
import { useCallback, useEffect, useState } from 'react'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import {
  listPractices, completionsThisWeek, markPracticeDone, unmarkPracticeDone,
} from '../services/practiceService'
import { monthStartIso } from '../utils/practiceLabel'
import { weekBoundaryStart } from '../utils/scheduling'
import { applicableTodayRoutines, type TodayRoutine } from '../utils/routineToday'

/** Fetches active practices + this-period completions and returns the routines
 *  applicable today (pinned-due + flex-under-target), part-of-day sorted, plus a
 *  toggle. Single source of routine logic for both the Schedule and Today views. */
export function useTodayRoutines(date: string): {
  routines: TodayRoutine[]
  toggle: (id: string) => Promise<void>
  loading: boolean
} {
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)

  const weekStart = weekBoundaryStart(date)
  // Cover month-period flex routines: fetch since the earlier of week- and month-start.
  const monthStart = monthStartIso(date)
  const periodFrom = monthStart < weekStart ? monthStart : weekStart

  const load = useCallback(async () => {
    const [ps, cs] = await Promise.all([listPractices(true), completionsThisWeek(periodFrom)])
    setPractices(ps)
    setCompletions(cs)
    setLoading(false)
  }, [periodFrom])

  useEffect(() => {
    let cancelled = false
    void load().catch((err) => { if (!cancelled) console.error('useTodayRoutines: load failed', err) })
    return () => { cancelled = true }
  }, [load])

  const routines = applicableTodayRoutines(practices, completions, date, weekStart)

  const toggle = useCallback(async (id: string) => {
    const isDone = completions.some((c) => c.practice_id === id && c.completed_on === date)
    if (isDone) await unmarkPracticeDone(id, date)
    else await markPracticeDone(id, date)
    await load()
  }, [completions, date, load])

  return { routines, toggle, loading }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from the new hook (existing `Today.tsx`/`ScheduleOverview.tsx` still compile — they're updated in Tasks 3–4).

- [ ] **Step 3: Commit**
```bash
git add src/hooks/useTodayRoutines.ts
git commit -m "feat(routines): useTodayRoutines hook (shared fetch/filter/toggle)"
```

---

## Task 3: Fold routines into `Today.tsx`

**Files:**
- Modify: `src/components/Today.tsx`

- [ ] **Step 1: Read the current file**

Read `src/components/Today.tsx` fully. It currently imports `listPractices`/`markPracticeDone`/`unmarkPracticeDone`/`completionsThisWeek` and `practiceLabel`/`doneThisPeriod`/`monthStartIso`, holds `practices` + `completions` state, and renders a "Briefing" section and a "Practices" section that lists ALL active practices.

- [ ] **Step 2: Replace practice plumbing with the hook + folded rows**

- Remove the practice imports and the `practices`/`completions` state and their fetch (keep the `getTodayBriefing` briefing fetch and the briefing section untouched).
- Add: `import { useTodayRoutines } from '../hooks/useTodayRoutines'`.
- In the component: `const { routines, toggle } = useTodayRoutines(date)`.
- Delete the entire `<section>` with the "Practices" `<h2>` and its all-practices list.
- Under the Briefing section, render the folded routines (no "Practices" header). When `routines.length === 0`, render nothing. Otherwise:
```tsx
{routines.length > 0 && (
  <ul className="space-y-2">
    {routines.map((r) => (
      <li key={r.id}>
        <label className="flex items-center gap-3 cursor-pointer min-h-[44px] py-1">
          <input
            type="checkbox"
            className="h-5 w-5 accent-amber-600 shrink-0"
            checked={r.done}
            onChange={() => void toggle(r.id)}
            aria-label={r.done ? 'Mark not done' : 'Mark done'}
          />
          <span className={r.done ? 'line-through text-gray-400' : ''}>{r.label}</span>
        </label>
      </li>
    ))}
  </ul>
)}
```
(Match the checkbox/label styling the file already used for its practice rows — reuse the same classes that were on the deleted rows so the visual is unchanged.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. No remaining references to `listPractices`/`completionsThisWeek`/`practiceLabel`/`doneThisPeriod` in `Today.tsx` (the hook owns them now).
Verify: `grep -nE "listPractices|completionsThisWeek|practiceLabel|doneThisPeriod|Practices" src/components/Today.tsx` → no practice-section hits.

- [ ] **Step 4: Commit**
```bash
git add src/components/Today.tsx
git commit -m "feat(routines): fold today-applicable routines into Today view (no Practices section)"
```

---

## Task 4: Remove `RoutinesCard`; interleave routines into `WeekCard`

**Files:**
- Modify: `src/components/ScheduleOverview.tsx`

- [ ] **Step 1: Read the current file**

Read `src/components/ScheduleOverview.tsx`. Note: the top-level `ScheduleOverview` renders `<RoutinesCard />` then `<TodayScheduleCard .../>` then `<OverdueCard/>` then `<WeekCard/>` then `<ThisMonthCard/>`. `RoutinesCard` (a self-contained component) fetches practices/completions and renders the dedicated list. `WeekCard` builds `rows` via `buckets.flatMap(...)` over `buildWeekAgenda(events, now)`, where each bucket has `{ dateKey, events, isToday, isPast }`; the `WeekRow` union currently has `{ kind: 'empty' }` and `{ kind: 'event' }`.

- [ ] **Step 2: Delete `RoutinesCard`**

- Remove the `<RoutinesCard />` element from the `ScheduleOverview` return.
- Delete the entire `function RoutinesCard() { ... }` definition (including its "+N more in Routines" overflow `<li>`).
- Remove now-unused imports if they are no longer referenced anywhere else in the file: `listPractices`, `completionsThisWeek`, `markPracticeDone`, `unmarkPracticeDone`, `practiceLabel`, `doneThisPeriod`, `monthStartIso`, `PracticeRow`, `PracticeCompletionRow`. (Grep each before removing — `WeekCard` will re-introduce `doneThisPeriod`? No. Only remove ones with zero remaining references.)

- [ ] **Step 3: Add the `routine` row variant + interleave in `WeekCard`**

- Add `import { useTodayRoutines } from '../hooks/useTodayRoutines'` and `import type { TodayRoutine } from '../utils/routineToday'`.
- Extend the `WeekRow` union with a routine variant:
```ts
type WeekRow =
  | { kind: 'empty'; key: string }
  | { kind: 'event'; key: string; event: Event; isToday: boolean; isPast: boolean; clash: boolean }
  | { kind: 'routine'; key: string; routine: TodayRoutine }
```
- Inside `WeekCard`, after `const buckets = buildWeekAgenda(events, now)`:
```ts
const todayKey = todayIso()
const { routines, toggle: toggleRoutine } = useTodayRoutines(todayKey)
// Minutes-of-day for ordering today's rows; untimed events sort first (−1),
// timed events by their clock time, routines by part-of-day (anytime last).
const eventMins = (e: Event): number => {
  const t = timeOf(e) // 'HH:MM' or ''
  if (!t) return -1
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
```
- Replace the `rows` construction so the **today** bucket merges events + routines sorted by minutes, and other buckets are unchanged:
```ts
const rows = buckets.flatMap<WeekRow>((b) => {
  if (b.isToday) {
    const clashes = overlappingIds(b.events)
    const eventRows = b.events.map((e) => ({
      sortMins: eventMins(e),
      row: { kind: 'event', key: e.id, event: e, isToday: true, isPast: b.isPast, clash: clashes.has(e.id) } as WeekRow,
    }))
    const routineRows = routines.map((r) => ({
      sortMins: r.sortMins,
      row: { kind: 'routine', key: `routine-${r.id}`, routine: r } as WeekRow,
    }))
    const merged = [...eventRows, ...routineRows].sort((a, b2) => a.sortMins - b2.sortMins)
    if (merged.length === 0) return [{ kind: 'empty', key: b.dateKey }]
    return merged.map((m) => m.row)
  }
  if (b.events.length === 0) return [{ kind: 'empty', key: b.dateKey }]
  const clashes = overlappingIds(b.events)
  return b.events.map((e) => ({
    kind: 'event', key: e.id, event: e, isToday: b.isToday, isPast: b.isPast, clash: clashes.has(e.id),
  }))
})
```
- In the `rows.map(...)` render, add a branch for the routine row BEFORE the event branch:
```tsx
if (row.kind === 'routine') {
  const r = row.routine
  return (
    <li key={row.key} className="break-inside-avoid mb-1">
      <label className="flex items-center gap-1.5 w-full text-base leading-6 rounded px-1.5 bg-yellow-100/60 cursor-pointer">
        <input
          type="checkbox"
          className="h-4 w-4 accent-amber-600 shrink-0"
          checked={r.done}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => void toggleRoutine(r.id)}
          aria-label={r.done ? 'Mark not done' : 'Mark done'}
        />
        <span className={r.done ? 'line-through text-gray-400' : ''}>{r.label}</span>
      </label>
    </li>
  )
}
```
(The `bg-yellow-100/60` matches today's highlight used by the event rows.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. Verify no dangling `RoutinesCard` references: `grep -n "RoutinesCard" src/components/ScheduleOverview.tsx` → nothing.

- [ ] **Step 5: Commit**
```bash
git add src/components/ScheduleOverview.tsx
git commit -m "feat(routines): drop RoutinesCard; interleave today routines into This week"
```

---

## Task 5: Update tests + full verification

**Files:**
- Modify: `src/components/ScheduleOverview.test.tsx`

- [ ] **Step 1: Read the existing test**

Read `src/components/ScheduleOverview.test.tsx`. It currently has a test that renders `ScheduleOverview` and exercises the routines/practices list (the Phase-1 "lists practices and toggles completion" test referenced `RoutinesCard` behavior). Identify the practice-mocking and the assertions tied to the old `RoutinesCard`.

- [ ] **Step 2: Update the test to the folded behavior**

- The service mocks for `listPractices`/`completionsThisWeek`/`markPracticeDone`/`unmarkPracticeDone` stay (they're now consumed by `useTodayRoutines`).
- Replace any assertion that looked for a dedicated "Routines" section/heading with assertions that a **today-applicable** routine renders inside the "This week" card (`data-testid="week-card"`), as a checkable row with its label (e.g. a pinned-daily `Sunscreen (daily)` and a flex `Gym (0/3 this week)`), and that a routine NOT applicable today (e.g. a pinned weekly routine on a non-matching weekday) is absent.
- Keep the toggle test: clicking the routine checkbox calls `markPracticeDone`/`unmarkPracticeDone`.
- Use generic personas only ("Sunscreen", "Gym", "Walk") — repo is PUBLIC.
- If fixtures used the old practice shape, ensure they use the unified-recurrence shape (`recurrence_mode`/`recurrence_rule`/`flex_period`/`flex_target`) — the same shape the Phase-1 tests already use. Pick `dtstart`/today values so the pinned routine is due on the test's "today" (the component uses the real current date via `todayIso()`; prefer a daily-cadence pinned routine so it's due every day, avoiding date flakiness).

- [ ] **Step 3: Run the focused tests**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx src/utils/routineToday.test.ts`
Expected: PASS.

- [ ] **Step 4: Full type-check + web suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests PASS. If `Today.tsx` had a test asserting the old "Practices" section, update it to the folded behavior (only today-applicable routines, no "Practices" header) as part of this step.

- [ ] **Step 5: Engine + parity guards unaffected (sanity)**

Run: `npm run check:parity`
Expected: both green — this change touches no engine mirror or MCP tool (only web display).

- [ ] **Step 6: Commit**
```bash
git add src/components/ScheduleOverview.test.tsx src/components/Today.tsx src/components/ScheduleOverview.tsx 2>/dev/null
git commit -m "test(routines): cover folded today routines; drop RoutinesCard assertions"
```

---

## Self-Review

**Spec coverage:**
- ✅ No dedicated section — `RoutinesCard` deleted (Task 4), Today "Practices" section removed (Task 3).
- ✅ Only today-applicable (pinned-due + flex-under-target) — `isRoutineApplicableToday` (Task 1).
- ✅ Done routines stay checked; flex shows progress — `applicableTodayRoutines` keeps done rows + `practiceLabel` (Task 1), rows render checked/struck (Tasks 3–4).
- ✅ Interleave by part-of-day — `partOfDayMins` + the `WeekCard` merge sort (Tasks 1, 4); Today orders by `sortMins` (Task 3).
- ✅ Shared hook — `useTodayRoutines` (Task 2), consumed by both surfaces.
- ✅ Testing — `routineToday.test.ts` (Task 1), updated component tests (Task 5).
- ⏭️ Future-day routines, create UI, custom ordering — out of scope per spec.

**Type consistency:** `TodayRoutine` (`{id,label,done,sortMins}`) is defined in `routineToday.ts` (Task 1) and consumed by the hook (Task 2) and `WeekCard` (Task 4) identically. `useTodayRoutines` returns `{ routines, toggle, loading }` (Task 2) used the same way in Tasks 3–4. `partOfDayMins`/`applicableTodayRoutines`/`isRoutineApplicableToday` signatures match across tasks.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command states expected output.
