# Schedule: Ranged "This week" + Calendar Dot Cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Schedule page's "This week" card a Today-first ranged view (`Today` | `This Week` | `Next Week`), and raise the compact calendar dot cap from 5 to 11.

**Architecture:** `buildWeekAgenda` gains an optional `today` arg so it can build any ISO week with correct today/past flags. `WeekCard` holds a `range` state (default `today`) selecting which `buildWeekAgenda(...)` feeds its existing flatten/routine-merge row builder. `CalendarGrid`'s `DOT_CAP` constant changes to 11.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react.

**Design:** `docs/superpowers/specs/2026-06-10-schedule-ranged-week-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/utils/weekAgenda.ts` | `buildWeekAgenda` gains optional `today` param | Modify |
| `src/utils/weekAgenda.test.ts` | Test the new overload | Modify/Create |
| `src/components/ScheduleOverview.tsx` | `WeekCard` ranged control + range→buckets + empty states | Modify |
| `src/components/ScheduleOverview.test.tsx` | Default-Today + tab switching + routines coverage | Modify |
| `src/components/CalendarGrid.tsx` | `DOT_CAP` 5 → 11 | Modify |
| `src/components/CalendarGrid.test.tsx` | Dot rendering at the new cap | Create (if absent) |

---

## Task 1: `buildWeekAgenda` optional `today` arg

**Files:**
- Modify: `src/utils/weekAgenda.ts`
- Modify/Create: `src/utils/weekAgenda.test.ts`

- [ ] **Step 1: Write/extend the failing test** — add to `src/utils/weekAgenda.test.ts` (create the file if it doesn't exist, importing what the other component tests import):
```ts
import { describe, it, expect } from 'vitest'
import { buildWeekAgenda, ymd } from './weekAgenda'
import type { Event } from '../lib/dbClient/types' // adjust to the actual Event type import used elsewhere

function evt(id: string, startISO: string): Event {
  // Minimal Event for agenda bucketing — mirror the shape other tests in the repo use.
  return { id, start_date: startISO, event_kind: 'event' } as unknown as Event
}

describe('buildWeekAgenda with explicit today', () => {
  it('builds next week with all buckets non-today / non-past', () => {
    const now = new Date('2026-06-10T12:00:00') // Wednesday
    const nextWeekRef = new Date('2026-06-17T12:00:00') // +7d, next Wednesday
    const e = evt('n1', '2026-06-18T09:00:00') // a Thursday next week
    const buckets = buildWeekAgenda([e], nextWeekRef, now)
    expect(buckets.length).toBeGreaterThan(0)
    expect(buckets.every((b) => b.isToday === false)).toBe(true)
    expect(buckets.every((b) => b.isPast === false)).toBe(true)
    expect(buckets.some((b) => b.events.some((x) => x.id === 'n1'))).toBe(true)
  })

  it('two-arg form is unchanged: today flagged, earlier days past', () => {
    const now = new Date('2026-06-10T12:00:00') // Wednesday; ISO week Mon 06-08..Sun 06-14
    const buckets = buildWeekAgenda([], now)
    const today = buckets.find((b) => b.dateKey === ymd(now))
    expect(today?.isToday).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (the 3-arg call is a type/behaviour error until implemented)

Run: `npx vitest run src/utils/weekAgenda.test.ts`
Expected: FAIL (next-week buckets currently computed against `nextWeekRef`, so they'd be flagged today/past incorrectly — or a TS arity error).

- [ ] **Step 3: Implement the overload** in `src/utils/weekAgenda.ts`

Change the signature and the three internal references that derive "today" from the week reference:
```ts
export function buildWeekAgenda(events: Event[], weekRef: Date, today: Date = weekRef): DayBucket[] {
  const days = weekDays(weekRef)
  const todayKey = ymd(today)
  const weekStart = ymd(days[0])
  const weekEnd = ymd(days[6])
  // ... (byDay bucketing unchanged) ...
  // inside the per-day loop, keep:
  //   const isToday = dateKey === todayKey
  //   isPast: dateKey < todayKey,
  //   if (evs.length === 0 && !isToday) continue
}
```
Concretely: rename the current `now` parameter to `weekRef`, add `today: Date = weekRef`, and replace `const todayKey = ymd(now)` with `const todayKey = ymd(today)` and `weekDays(now)` with `weekDays(weekRef)`. All other logic stays identical. (Callers passing two args get `today === weekRef`, preserving current behaviour.)

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/utils/weekAgenda.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check (existing callers still compile)**

Run: `npx tsc --noEmit`
Expected: no errors (the only caller, `WeekCard`, still passes two args at this point).

- [ ] **Step 6: Commit**
```bash
git add src/utils/weekAgenda.ts src/utils/weekAgenda.test.ts
git commit -m "feat(schedule): buildWeekAgenda accepts explicit today (for arbitrary weeks)"
```

---

## Task 2: `WeekCard` ranged Today / This Week / Next Week

**Files:**
- Modify: `src/components/ScheduleOverview.tsx`

- [ ] **Step 1: Add range state + range→buckets + addDays**

In `WeekCard` (currently begins `function WeekCard({ events, ...actions }...)`), after `const now = useNow()`:
- Add: `const [range, setRange] = useState<'today' | 'this-week' | 'next-week'>('today')`.
- Add a local helper near the top of the component:
```ts
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
```
- Replace `const buckets = buildWeekAgenda(events, now)` with:
```ts
const buckets =
  range === 'today'
    ? buildWeekAgenda(events, now).filter((b) => b.isToday)
    : range === 'next-week'
      ? buildWeekAgenda(events, addDays(now, 7), now)
      : buildWeekAgenda(events, now)
```
Leave the rest of the row-building (`todayKey`, `useTodayRoutines`, `eventMins`, the `rows = buckets.flatMap(...)`) exactly as-is — it already keys routine rows off `b.isToday`, so Next Week (no today bucket) shows no routines automatically.

- [ ] **Step 2: Replace the heading with the segmented control**

Replace:
```tsx
<h3 className={`${sketchHand} text-3xl text-gray-900 mb-2`}>This week</h3>
```
with a 3-segment control (reuse the card's sketch styling; active segment highlighted with the existing `bg-yellow-100/60` today accent):
```tsx
<div className="flex items-center gap-1 mb-2" role="tablist" aria-label="Schedule range">
  {([['today', 'Today'], ['this-week', 'This Week'], ['next-week', 'Next Week']] as const).map(([val, label]) => (
    <button
      key={val}
      type="button"
      role="tab"
      aria-selected={range === val}
      onClick={() => setRange(val)}
      className={`${sketchHand} text-2xl px-2 rounded ${
        range === val ? 'text-gray-900 bg-yellow-100/70' : 'text-gray-400 hover:text-gray-600'
      }`}
    >
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 3: Add the empty-range placeholder**

The Next Week range can produce zero rows (no events → `buildWeekAgenda` returns `[]`). After the `rows` are built and before/at the `<ul>`, render a placeholder when empty. Change the list region to:
```tsx
{rows.length === 0 ? (
  <p className="text-base text-gray-500 px-1.5">
    {range === 'next-week' ? 'Nothing scheduled next week.' : range === 'today' ? 'Nothing scheduled today.' : 'Nothing scheduled this week.'}
  </p>
) : (
  <ul className="md:columns-2 gap-x-6">
    {rows.map((row) => { /* ...existing render unchanged... */ })}
  </ul>
)}
```
(Keep the existing `rows.map(...)` body exactly as it is — only wrap it in the empty-check.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**
```bash
git add src/components/ScheduleOverview.tsx
git commit -m "feat(schedule): Today-first ranged week card (Today / This Week / Next Week)"
```

---

## Task 3: Raise calendar dot cap to 11

**Files:**
- Modify: `src/components/CalendarGrid.tsx`
- Create (if absent): `src/components/CalendarGrid.test.tsx`

- [ ] **Step 1: Check for an existing dot test**

Run: `ls src/components/CalendarGrid*.test.tsx 2>/dev/null` and grep any existing test for `DOT_CAP`/dots. If a test asserts the old cap of 5, update it in Step 3; otherwise create the focused test below.

- [ ] **Step 2: Change the constant**

In `src/components/CalendarGrid.tsx`, change:
```ts
const DOT_CAP = 5
```
to:
```ts
const DOT_CAP = 11
```
(The comment above — "Max dots rendered per kind in a compact cell before showing a '+' overflow." — stays accurate.)

- [ ] **Step 3: Add/adjust a focused dot test** — `src/components/CalendarGrid.test.tsx`

If no calendar test exists, add one that renders `CalendarGrid` in compact mode for a month, seeds a single day with N events of one kind, and asserts the dot count. Mirror how other component tests in this repo mock data and render (look at `CalendarGrid.todo.test.tsx` for the existing render harness + props). The assertions:
- A day with 7 same-kind events renders 7 dots (would have been capped at 5 before).
- A day with 12 same-kind events renders 11 dots **and** the "+" overflow marker.
Query dots by their class (`bg-blue-600` for events) within the day cell, or by the cell's `aria-label` carrying the true count. Use generic data only. If wiring a full `CalendarGrid` render is heavy, instead assert via the count math by extracting `DOT_CAP` is impractical (it's module-private) — prefer the render-based test mirroring `CalendarGrid.todo.test.tsx`. If that harness genuinely can't express dot-counting, document why and rely on the manual smoke + the visual deploy instead (note it in the commit).

- [ ] **Step 4: Run the calendar tests**

Run: `npx vitest run src/components/CalendarGrid.test.tsx src/components/CalendarGrid.todo.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/components/CalendarGrid.tsx src/components/CalendarGrid.test.tsx 2>/dev/null
git commit -m "feat(schedule): raise compact calendar dot cap 5 -> 11"
```

---

## Task 4: Component tests + full verification

**Files:**
- Modify: `src/components/ScheduleOverview.test.tsx`

- [ ] **Step 1: Read the current test**

Read `src/components/ScheduleOverview.test.tsx`. It already renders `ScheduleOverview` and asserts routines fold into the `week-card` (from the prior feature). Note how it seeds `events` and queries within the `week-card` testid.

- [ ] **Step 2: Add range-behaviour tests**

Add cases (keep the existing routine-fold + toggle tests, which now exercise the **Today** default view):
- **Defaults to Today:** seed one event dated **today** and one dated a different day **this week** (e.g. today+2, still within Mon–Sun). On initial render, the today event is visible in `week-card` and the other-day event is NOT (Today view only).
- **Tap "This Week":** `fireEvent.click(screen.getByRole('tab', { name: 'This Week' }))` → the other-day event now appears.
- **Tap "Next Week":** seed an event dated next week (today+7..+9). Click the `Next Week` tab → that event appears, and assert **no routine checkbox** is present in `week-card` (routines are today-only). Use `within(weekCard).queryByRole('checkbox', ...)` appropriately — be careful not to match todo checkboxes; assert the specific routine label (e.g. `Gym (0/3 this week)`) is absent.
- Compute "today"/offsets via `new Date()` + day arithmetic so the test isn't pinned to a calendar date; format with the same `ymd`/ISO approach the component expects for `start_date`. Use a **pinned daily** routine fixture (due every day) and generic personas only ("School run", "Gym", "Sunscreen").

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx src/utils/weekAgenda.test.ts`
Expected: PASS.

- [ ] **Step 4: Full type-check + suite + parity sanity**

Run:
```bash
npx tsc --noEmit && npx vitest run
npm run check:parity
```
Expected: no type errors; all tests PASS; MCP + engine parity green (this change touches neither). Fix any test that asserted the old always-full-week "This week" behaviour (update to the Today default).

- [ ] **Step 5: Commit**
```bash
git add src/components/ScheduleOverview.test.tsx
git commit -m "test(schedule): cover ranged week (Today default, tab switching, no next-week routines)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Ranged Today/This Week/Next Week, default Today — Task 2.
- ✅ This Week = full Mon–Sun; Next Week = next Mon–Sun events-only — Task 2 buckets + Task 1 overload.
- ✅ Routines today-only (present Today/This Week, absent Next Week) — unchanged merge keyed on `isToday` (Task 2); asserted Task 4.
- ✅ `buildWeekAgenda` explicit-today overload — Task 1.
- ✅ Empty-range placeholders — Task 2 Step 3.
- ✅ Dot cap 5 → 11 — Task 3.
- ✅ Testing across weekAgenda, ScheduleOverview, CalendarGrid — Tasks 1, 3, 4.
- ⏭️ Range persistence, arbitrary navigation, dot styling — out of scope per spec.

**Type consistency:** `range` is `'today' | 'this-week' | 'next-week'` in Task 2 and the tab values in Task 2/Task 4 match exactly. `buildWeekAgenda(events, weekRef, today?)` signature (Task 1) is called with 2 args (Today/This Week) and 3 args (Next Week) in Task 2 consistently. `DOT_CAP` is the single constant changed (Task 3).

**Placeholder scan:** Every code step shows complete code; commands state expected output. The only soft spot is Task 3 Step 3 (calendar test harness) which is explicitly conditional with a documented fallback — not a silent TODO.
