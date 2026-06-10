# Unified Recurrence on Practices (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the practice `frequency_type` 3-way enum (`daily`/`weekly_count`/`specific_days`) with a unified recurrence model — **pinned** (a structured `RecurrenceRule`, supporting every-N-days, weekdays, monthly) and **flex_count** (N completions per week/month) — so routines like "meal prep every alternate day" become expressible alongside "gym 3×/week".

**Architecture:** This is Phase 1 of the unified-scheduling design (`docs/superpowers/specs/2026-06-10-unified-scheduling-design.md`). It reuses the **existing** structured `RecurrenceRule` shape (`mcp/src/recurrence.ts`) — the same JSONB representation events already store in `events.recurrence_rule` — rather than introducing raw RRULE-string parsing. A new pure `occursOn()` matcher decides whether a pinned practice is due on a given date (interval-anchored at a `dtstart`). Flex practices count completions within the current ISO week or calendar month. There are **zero practice rows** for the user today, so the migration drops the old columns with no backfill. Phases 2 (attendances + blackouts) and 3 (linked obligations) are separate plans.

**Tech Stack:** TypeScript, Postgres (`plannen` schema), the dual MCP servers (`mcp/src/index.ts` Tier 0 + `supabase/functions/mcp/` Tier 1/2), a Hono backend (`backend/src/routes/api/practices.ts`), a React web app (`src/`), and Vitest. Migrations run via `npx plannen migrate`.

**Representation decisions (locked):**
- Practices keep the coarse `preferred_time_of_day` enum. Precise `HH:MM` times are NOT added to practices — they belong to attendances/obligations in Phase 2/3 (practices are time-flexible by definition). This narrows the spec's "time_of_day HH:MM" to the time-pinned primitives only.
- Pinned recurrence is stored as `recurrence_rule jsonb` matching the existing `RecurrenceRule` interface: `{ frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: string[] }`. `days` uses the codebase's existing two-letter codes (`MO,TU,WE,TH,FR,SA,SU`) — same as events — NOT the practice layer's old lowercase `mon`/`tue` keys.
- `dtstart` (date) anchors interval math ("every 2 days" counts from here) and bounds the start; `recurrence_until` (date, nullable) bounds the end.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/20260610120000_practice_recurrence.sql` | DB: new practice columns, drop old | Create |
| `mcp/src/practices.ts` | Pure due/remaining logic (Tier 0 source of truth) | Rewrite |
| `mcp/src/practices.test.ts` | Tests for the pure logic | Rewrite |
| `supabase/functions/_shared/practices.ts` | Deno mirror of the pure logic | Rewrite |
| `supabase/functions/_shared/practices.test.ts` | Deno mirror of the tests | Rewrite |
| `mcp/src/index.ts` | Tier 0 tool schemas + handlers + `getBriefingContext` | Modify |
| `supabase/functions/mcp/tools/practices.ts` | Tier 1 tool schemas + handlers | Modify |
| `supabase/functions/mcp/tools/briefings.ts` | Tier 1 `getBriefingContext` | Modify |
| `backend/src/routes/api/practices.ts` | Hono zod schema + INSERT SQL | Modify |
| `src/lib/dbClient/types.ts` | `PracticeRow` type | Modify |
| `src/components/Today.tsx` | Practice label rendering + month-aware completion fetch | Modify |
| `src/components/ScheduleOverview.tsx` | `RoutinesCard` label rendering | Modify |
| `plugin/skills/.../plannen-core` (skill md) + tool descriptions | Agent guidance for the new recurrence | Modify |

---

## Task 1: DB migration — swap practice frequency columns for the unified model

**Files:**
- Create: `supabase/migrations/20260610120000_practice_recurrence.sql`

- [ ] **Step 1: Back up first (hard rule — never lose user data)**

Run (Tier 0 is the active mode):
```bash
bash scripts/export-seed.sh
```
Expected: writes `supabase/seed.sql` + `supabase/seed-photos.tar.gz` (both gitignored). If `export-seed.sh` errors because Supabase Docker isn't running (Tier 0 uses embedded pg), instead tar the data dir:
```bash
tar czf ~/plannen-pre-recurrence-backup.tgz -C ~/.plannen pgdata photos
```
Expected: a tarball exists at `~/plannen-pre-recurrence-backup.tgz`.

- [ ] **Step 2: Confirm there are zero practice rows (the migration drops columns without backfill)**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -tAc "SELECT count(*) FROM plannen.practices;"
```
Expected: `0`. **If this is not 0, STOP** — the drop-column path is unsafe and the migration must instead backfill old→new before dropping. Report back rather than proceeding.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260610120000_practice_recurrence.sql`:
```sql
-- Unified recurrence on practices (Phase 1).
-- Replaces frequency_type/target_count/days_of_week with a recurrence model:
--   recurrence_mode = 'pinned'      -> recurrence_rule (jsonb, RecurrenceRule shape)
--   recurrence_mode = 'flex_count'  -> flex_period + flex_target
-- Forward-only. Safe drop: zero practice rows exist at migration time (verified).

alter table plannen.practices
  add column recurrence_mode  text,
  add column recurrence_rule  jsonb,
  add column dtstart          date not null default current_date,
  add column recurrence_until date,
  add column flex_period      text,
  add column flex_target      integer;

-- No rows to backfill. Set a default mode so the NOT NULL below holds even if a
-- stray row appears between add and constraint.
update plannen.practices set recurrence_mode = 'flex_count', flex_period = 'week', flex_target = 1
  where recurrence_mode is null;

alter table plannen.practices
  alter column recurrence_mode set not null,
  drop column frequency_type,
  drop column target_count,
  drop column days_of_week;

alter table plannen.practices
  add constraint practices_recurrence_mode_chk
    check (recurrence_mode in ('pinned','flex_count')),
  add constraint practices_flex_period_chk
    check (flex_period is null or flex_period in ('week','month')),
  add constraint practices_flex_target_chk
    check (flex_target is null or flex_target between 1 and 31),
  add constraint practices_recurrence_shape_chk
    check (
      (recurrence_mode = 'pinned'
        and recurrence_rule is not null
        and flex_period is null and flex_target is null)
      or
      (recurrence_mode = 'flex_count'
        and flex_period is not null and flex_target is not null
        and recurrence_rule is null)
    );
```

- [ ] **Step 4: Apply the migration**

Run:
```bash
npx plannen migrate
```
Expected: the migration applies cleanly; no error. Verify the shape:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "\d plannen.practices"
```
Expected: columns `recurrence_mode`, `recurrence_rule`, `dtstart`, `recurrence_until`, `flex_period`, `flex_target` present; `frequency_type`, `target_count`, `days_of_week` gone.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260610120000_practice_recurrence.sql
git commit -m "feat(practices): migrate to unified recurrence model (pinned + flex_count)"
```

---

## Task 2: Rewrite the pure due/remaining logic (Tier 0 source of truth)

**Files:**
- Rewrite: `mcp/src/practices.ts`
- Test: `mcp/src/practices.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `mcp/src/practices.test.ts` with:
```ts
import { describe, it, expect } from 'vitest'
import {
  weekBoundaryStart,
  monthBoundaryStart,
  dayOfWeekKey,
  occursOn,
  isPracticeDueOn,
  remainingThisPeriod,
  type PracticeRow,
} from './practices.js'

const base = {
  id: 'p1', user_id: 'u1', family_member_id: null,
  name: 'x', category: 'household' as const,
  preferred_time_of_day: 'anytime' as const, active: true,
  recurrence_until: null,
}

describe('weekBoundaryStart', () => {
  it('returns Monday for a Wednesday', () => {
    expect(weekBoundaryStart('2026-05-20')).toBe('2026-05-18')
  })
  it('returns same date when called on Monday', () => {
    expect(weekBoundaryStart('2026-05-18')).toBe('2026-05-18')
  })
})

describe('monthBoundaryStart', () => {
  it('returns the 1st of the month', () => {
    expect(monthBoundaryStart('2026-05-20')).toBe('2026-05-01')
  })
})

describe('dayOfWeekKey', () => {
  it('maps Monday 2026-05-18 to "mon"', () => {
    expect(dayOfWeekKey('2026-05-18')).toBe('mon')
  })
})

describe('occursOn — daily interval (every-N-days / meal prep)', () => {
  const rule = { frequency: 'daily' as const, interval: 2 }
  it('is due on the anchor day', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-01')).toBe(true)
  })
  it('is due two days after the anchor', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-03')).toBe(true)
  })
  it('is NOT due on the off day', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-02')).toBe(false)
  })
  it('is NOT due before the anchor', () => {
    expect(occursOn(rule, '2026-06-01', '2026-05-31')).toBe(false)
  })
  it('treats interval 1 as plain daily', () => {
    expect(occursOn({ frequency: 'daily' }, '2026-06-01', '2026-06-05')).toBe(true)
  })
})

describe('occursOn — weekly with days + interval', () => {
  const rule = { frequency: 'weekly' as const, days: ['MO', 'WE', 'FR'] }
  it('is due on a listed weekday', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-03')).toBe(true) // Wed
  })
  it('is NOT due on an unlisted weekday', () => {
    expect(occursOn(rule, '2026-06-01', '2026-06-02')).toBe(false) // Tue
  })
  it('respects a 2-week interval (off-week suppressed)', () => {
    const biweekly = { frequency: 'weekly' as const, days: ['MO'], interval: 2 }
    expect(occursOn(biweekly, '2026-06-01', '2026-06-01')).toBe(true)  // anchor Mon
    expect(occursOn(biweekly, '2026-06-01', '2026-06-08')).toBe(false) // next Mon (off week)
    expect(occursOn(biweekly, '2026-06-01', '2026-06-15')).toBe(true)  // +2 weeks
  })
})

describe('occursOn — monthly', () => {
  const rule = { frequency: 'monthly' as const }
  it('is due on the same day-of-month as the anchor', () => {
    expect(occursOn(rule, '2026-06-10', '2026-07-10')).toBe(true)
  })
  it('is NOT due on a different day-of-month', () => {
    expect(occursOn(rule, '2026-06-10', '2026-07-11')).toBe(false)
  })
})

describe('isPracticeDueOn', () => {
  it('pinned daily-interval practice uses occursOn', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily', interval: 2 }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(true)
    expect(isPracticeDueOn(p, '2026-06-02', [])).toBe(false)
  })
  it('inactive practice is never due', () => {
    const p: PracticeRow = { ...base, active: false, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(false)
  })
  it('pinned practice past recurrence_until is not due', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      recurrence_until: '2026-06-02', flex_period: null, flex_target: null }
    expect(isPracticeDueOn(p, '2026-06-05', [])).toBe(false)
  })
  it('flex_count week practice is due while under target', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 3 }
    expect(isPracticeDueOn(p, '2026-06-03', [])).toBe(true)
  })
  it('flex_count week practice is NOT due once target met this week', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 2 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' },
      { practice_id: 'p1', completed_on: '2026-06-02' },
    ]
    expect(isPracticeDueOn(p, '2026-06-03', done)).toBe(false)
  })
  it('flex_count month practice counts within the calendar month', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'month', flex_target: 1 }
    const done = [{ practice_id: 'p1', completed_on: '2026-05-31' }] // previous month
    expect(isPracticeDueOn(p, '2026-06-10', done)).toBe(true)
  })
})

describe('remainingThisPeriod', () => {
  it('returns null for a pinned practice', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, dtstart: '2026-06-01',
      flex_period: null, flex_target: null }
    expect(remainingThisPeriod(p, '2026-06-03', [])).toBeNull()
  })
  it('counts only completions in the current week', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 3 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' }, // this week (Mon)
      { practice_id: 'p1', completed_on: '2026-05-25' }, // last week
    ]
    expect(remainingThisPeriod(p, '2026-06-03', done)).toBe(2)
  })
  it('floors at 0 when over-completed', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'flex_count',
      recurrence_rule: null, dtstart: '2026-06-01', flex_period: 'week', flex_target: 1 }
    const done = [
      { practice_id: 'p1', completed_on: '2026-06-01' },
      { practice_id: 'p1', completed_on: '2026-06-02' },
    ]
    expect(remainingThisPeriod(p, '2026-06-03', done)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd mcp && npx vitest run src/practices.test.ts
```
Expected: FAIL — `occursOn`, `monthBoundaryStart`, `remainingThisPeriod`, and the new `PracticeRow` shape are not exported yet.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `mcp/src/practices.ts` with:
```ts
// Pure helpers for the daily-plan agent. No DB / IO.
// All date arguments are UTC calendar dates ("YYYY-MM-DD"). Callers must
// normalise to UTC before passing (e.g. new Date().toISOString().slice(0, 10)).

export type RecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[] // two-letter codes: MO,TU,WE,TH,FR,SA,SU (same as events)
}

export type PracticeRow = {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule: RecurrenceRule | null
  dtstart: string // YYYY-MM-DD
  recurrence_until: string | null // YYYY-MM-DD
  flex_period: 'week' | 'month' | null
  flex_target: number | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
}

export type CompletionRow = {
  practice_id: string
  completed_on: string // YYYY-MM-DD
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
// RecurrenceRule.days uses two-letter codes; map to the ISO weekday name.
const CODE_TO_KEY: Record<string, typeof DAY_KEYS[number]> = {
  SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat',
}

function midnightUtcMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime()
}

function daysBetween(a: string, b: string): number {
  return Math.round((midnightUtcMs(b) - midnightUtcMs(a)) / 86_400_000)
}

/** ISO weekday: Mon=1..Sun=7. */
function weekday(date: string): number {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  return js === 0 ? 7 : js
}

/** Returns the Monday of the ISO week containing `date`, as "YYYY-MM-DD". */
export function weekBoundaryStart(date: string): string {
  const wd = weekday(date)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

/** Returns the 1st of the calendar month containing `date`, as "YYYY-MM-DD". */
export function monthBoundaryStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** "mon"/"tue"/.../"sun" for an ISO date. */
export function dayOfWeekKey(date: string): typeof DAY_KEYS[number] {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay()
  return DAY_KEYS[js]
}

/**
 * Does `rule` (anchored at `dtstart`) produce an occurrence on `date`?
 * Interval is counted from `dtstart`: every-2-days from Jun 1 lands on
 * Jun 1, 3, 5… Weekly interval is counted in whole ISO weeks; monthly in
 * whole calendar months on the same day-of-month as the anchor.
 */
export function occursOn(rule: RecurrenceRule, dtstart: string, date: string): boolean {
  if (date < dtstart) return false
  const interval = rule.interval ?? 1
  switch (rule.frequency) {
    case 'daily': {
      const diff = daysBetween(dtstart, date)
      return diff >= 0 && diff % interval === 0
    }
    case 'weekly': {
      const key = dayOfWeekKey(date)
      const days = (rule.days ?? []).map((c) => CODE_TO_KEY[c]).filter(Boolean)
      if (!days.includes(key)) return false
      const weeks = Math.round(daysBetween(weekBoundaryStart(dtstart), weekBoundaryStart(date)) / 7)
      return weeks >= 0 && weeks % interval === 0
    }
    case 'monthly': {
      if (date.slice(8, 10) !== dtstart.slice(8, 10)) return false
      const months =
        (Number(date.slice(0, 4)) - Number(dtstart.slice(0, 4))) * 12 +
        (Number(date.slice(5, 7)) - Number(dtstart.slice(5, 7)))
      return months >= 0 && months % interval === 0
    }
  }
}

function periodStart(period: 'week' | 'month', date: string): string {
  return period === 'week' ? weekBoundaryStart(date) : monthBoundaryStart(date)
}

function completionsInPeriodOf(practice: PracticeRow, date: string, completions: CompletionRow[]): number {
  if (practice.flex_period === null) return 0
  const start = periodStart(practice.flex_period, date)
  return completions.filter(
    (c) => c.practice_id === practice.id && c.completed_on >= start && c.completed_on <= date,
  ).length
}

export function isPracticeDueOn(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): boolean {
  if (!practice.active) return false
  if (practice.recurrence_mode === 'pinned') {
    if (!practice.recurrence_rule) return false
    if (practice.recurrence_until && date > practice.recurrence_until) return false
    return occursOn(practice.recurrence_rule, practice.dtstart, date)
  }
  // flex_count
  if (practice.flex_target === null) return false
  return completionsInPeriodOf(practice, date, completions) < practice.flex_target
}

/** Remaining completions needed this period (null for pinned practices). */
export function remainingThisPeriod(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): number | null {
  if (practice.recurrence_mode !== 'flex_count' || practice.flex_target === null) return null
  const done = completionsInPeriodOf(practice, date, completions)
  return Math.max(0, practice.flex_target - done)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd mcp && npx vitest run src/practices.test.ts
```
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add mcp/src/practices.ts mcp/src/practices.test.ts
git commit -m "feat(practices): unified recurrence due/remaining logic (occursOn + flex period)"
```

---

## Task 3: Mirror the pure logic into the Deno shared module

**Files:**
- Rewrite: `supabase/functions/_shared/practices.ts`
- Rewrite: `supabase/functions/_shared/practices.test.ts`

- [ ] **Step 1: Copy the implementation, keeping the sync header**

Replace the entire contents of `supabase/functions/_shared/practices.ts` with the 4-line sync header below, followed by the **exact body** of `mcp/src/practices.ts` from Task 2 Step 3 (everything after its top comment block):
```ts
// NOTE: This file is duplicated from mcp/src/practices.ts so the edge function
// runtime (Deno) can import it. Keep in sync. If they drift, fix here first
// then back-port to mcp/src/practices.ts (or vice versa).

export type RecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[]
}
// … (paste the rest verbatim: PracticeRow, CompletionRow, all helpers,
//     occursOn, isPracticeDueOn, remainingThisPeriod from mcp/src/practices.ts)
```
The two files must be logic-identical (the only allowed difference is the comment header), so `diff mcp/src/practices.ts supabase/functions/_shared/practices.ts` shows only the header lines.

- [ ] **Step 2: Copy the tests**

Replace `supabase/functions/_shared/practices.test.ts` with the same test bodies as `mcp/src/practices.test.ts` (Task 2 Step 1), changing only the import path:
```ts
import {
  weekBoundaryStart, monthBoundaryStart, dayOfWeekKey, occursOn,
  isPracticeDueOn, remainingThisPeriod, type PracticeRow,
} from './practices.ts'
// … rest identical to mcp/src/practices.test.ts
```

- [ ] **Step 3: Run the Deno-side tests**

Run:
```bash
cd supabase/functions && npx vitest run _shared/practices.test.ts
```
Expected: PASS.

- [ ] **Step 4: Verify the two implementations match**

Run:
```bash
diff <(tail -n +5 supabase/functions/_shared/practices.ts) <(tail -n +5 mcp/src/practices.ts)
```
Expected: no output (identical after their respective comment headers). If lines differ, reconcile before committing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/practices.ts supabase/functions/_shared/practices.test.ts
git commit -m "feat(practices): mirror unified recurrence logic into _shared (Deno)"
```

---

## Task 4: Tier 0 MCP — tool schemas, handlers, and briefing context

**Files:**
- Modify: `mcp/src/index.ts:1671-1761` (handlers), `:1880-1909` (briefing), `:2469-2514` (schemas)

- [ ] **Step 1: Update the `PracticeInput` type and `listPractices`/`createPractice` handlers**

In `mcp/src/index.ts`, replace the `listPractices` SELECT column list (`:1682-1683`) and the `PracticeInput` type + `createPractice` (`:1693-1725`) so the new columns are used. New SELECT columns (used in both `listPractices` and `getBriefingContext`):
```ts
// SELECT list — replace `frequency_type, target_count, days_of_week, preferred_time_of_day`
`id, family_member_id, name, category, recurrence_mode, recurrence_rule,
 dtstart::text, recurrence_until::text, flex_period, flex_target,
 preferred_time_of_day, active, created_at, updated_at`
```
New `PracticeInput` + `createPractice`:
```ts
type PracticeInput = {
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule?: { frequency: 'daily' | 'weekly' | 'monthly'; interval?: number; days?: string[] } | null
  dtstart?: string | null
  recurrence_until?: string | null
  flex_period?: 'week' | 'month' | null
  flex_target?: number | null
  preferred_time_of_day?: 'morning' | 'afternoon' | 'evening' | 'anytime'
  family_member_id?: string | null
}

async function createPractice(args: PracticeInput) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.practices
         (user_id, family_member_id, name, category, recurrence_mode,
          recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
          preferred_time_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10, COALESCE($11, 'anytime'))
       RETURNING *`,
      [
        id,
        args.family_member_id ?? null,
        args.name,
        args.category,
        args.recurrence_mode,
        args.recurrence_rule ? JSON.stringify(args.recurrence_rule) : null,
        args.dtstart ?? null,
        args.recurrence_until ?? null,
        args.flex_period ?? null,
        args.flex_target ?? null,
        args.preferred_time_of_day ?? null,
      ],
    )
    return rows[0]
  })
}
```
`updatePractice` and `deletePractice` need no change — `updatePractice` builds its SET clause generically from `Object.entries(args)`, so it already handles the new columns (a `recurrence_rule` object value is passed straight to `node-postgres`, which serialises objects to JSONB). `markPracticeDone`/`unmarkPracticeDone` are unchanged.

- [ ] **Step 2: Update `getBriefingContext` to use the new columns + helper**

In `mcp/src/index.ts`, update the practices query (`:1880-1882`) SELECT to:
```ts
`SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
        dtstart::text, recurrence_until::text, flex_period, flex_target,
        preferred_time_of_day, active
 FROM plannen.practices WHERE user_id = $1 AND active = true`
```
Update the import (`:near top, where practices helpers are imported`) and the mapping block (`:1900-1909`) to use `remainingThisPeriod` instead of `remainingThisWeek`, and rename the output field:
```ts
import { isPracticeDueOn, remainingThisPeriod, weekBoundaryStart } from './practices.js'
// …
const practicesDue = (practicesRow.rows as Parameters<typeof isPracticeDueOn>[0][])
  .filter((p) => isPracticeDueOn(p, today, allCompletions))
  .map((p) => {
    const inPeriod = allCompletions.filter((c) => c.practice_id === p.id).length
    return {
      ...p,
      completions_this_period: inPeriod,
      remaining_this_period: remainingThisPeriod(p, today, allCompletions),
    }
  })
```
> Note: `getBriefingContext` already fetches completions only `>= weekBoundaryStart(today)`. For a `month`-period flex practice that window is too short to count the whole month. Widen the completions fetch (`:1885-1890`) to the earlier of week-start and month-start:
```ts
const monthStart = `${today.slice(0, 7)}-01`
const completionsFrom = monthStart < wkStart ? monthStart : wkStart
// … then use `completionsFrom` instead of `wkStart` in the completions query params
```

- [ ] **Step 3: Update the three tool schemas (`list_practices` is fine; change `create_practice` + `update_practice`)**

Replace the `create_practice` schema (`:2480-2495`) properties with:
```ts
properties: {
  name: { type: 'string' },
  category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
  recurrence_mode: { type: 'string', enum: ['pinned', 'flex_count'],
    description: "'pinned' = fires on specific recurring dates (use recurrence_rule); 'flex_count' = N times per week/month, anytime (use flex_period + flex_target)." },
  recurrence_rule: { type: 'object',
    description: "Required when recurrence_mode='pinned'. { frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }. Examples: every other day = {frequency:'daily',interval:2}; weekdays = {frequency:'weekly',days:['MO','TU','WE','TH','FR']}; monthly = {frequency:'monthly'}.",
    properties: {
      frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
      interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
      days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
    },
    required: ['frequency'] },
  dtstart: { type: 'string', description: 'YYYY-MM-DD anchor/start date. Defaults to today. For every-N-days this is the date the cadence counts from.' },
  recurrence_until: { type: 'string', description: 'Optional YYYY-MM-DD end date for the recurrence.' },
  flex_period: { type: 'string', enum: ['week', 'month'], description: "Required when recurrence_mode='flex_count'." },
  flex_target: { type: 'number', description: "Required when recurrence_mode='flex_count'. Completions per period, 1–31 (e.g. gym 3×/week = period 'week', target 3)." },
  preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
  family_member_id: { type: ['string', 'null'], description: 'Optional — owner is a circle member rather than the user themselves.' },
},
required: ['name', 'category', 'recurrence_mode'],
```
Also update the `create_practice` `description` (`:2481`) to:
```
'Create a recurring routine. recurrence_mode="pinned" for date-cadence routines (every other day, weekdays, monthly — set recurrence_rule); recurrence_mode="flex_count" for "N times per week/month, anytime" (gym 3×/week — set flex_period + flex_target). For time-pinned attendance like a school drop-off, use a recurring event/attendance instead, not a practice.'
```
Mirror the same property set into the `update_practice` schema (`:2497-2513`), adding `id` (required) and `active` (boolean), and leaving `required: ['id']`.

- [ ] **Step 4: Build the Tier 0 server to verify types compile**

Run:
```bash
cd mcp && npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(practices): Tier 0 MCP tools + briefing use unified recurrence"
```

---

## Task 5: Tier 1 MCP — mirror schemas + handlers

**Files:**
- Modify: `supabase/functions/mcp/tools/practices.ts`

- [ ] **Step 1: Replace the `create_practice` + `update_practice` definitions**

In `supabase/functions/mcp/tools/practices.ts`, replace the `create_practice` (`:17-33`) and `update_practice` (`:34-52`) definition objects with the **exact** schema objects authored in Task 4 Step 3 (same `properties`, `description`, `required`). The parity checker matches on `name:` lines only, but the schemas must agree for behaviour parity.

- [ ] **Step 2: Replace the `listPractices` SELECT and `createPractice` handler**

Update the `listPractices` SELECT (`:103-104`) to the new column list from Task 4 Step 1. Replace the `createPractice` handler (`:113-142`) with:
```ts
const createPractice: ToolHandler = async (args, ctx) => {
  const a = args as {
    name: string; category: string; recurrence_mode: string
    recurrence_rule?: unknown; dtstart?: string | null; recurrence_until?: string | null
    flex_period?: string | null; flex_target?: number | null
    preferred_time_of_day?: string | null; family_member_id?: string | null
  }
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.practices
       (user_id, family_member_id, name, category, recurrence_mode,
        recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
        preferred_time_of_day)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10, COALESCE($11, 'anytime'))
     RETURNING *`,
    [
      ctx.userId,
      a.family_member_id ?? null,
      a.name,
      a.category,
      a.recurrence_mode,
      a.recurrence_rule ? JSON.stringify(a.recurrence_rule) : null,
      a.dtstart ?? null,
      a.recurrence_until ?? null,
      a.flex_period ?? null,
      a.flex_target ?? null,
      a.preferred_time_of_day ?? null,
    ],
  )
  return rows[0]
}
```
`updatePractice`, `deletePractice`, `markPracticeDone`, `unmarkPracticeDone` are unchanged.

- [ ] **Step 3: Run the Tier 1 practices test + parity check**

Run:
```bash
cd supabase/functions && npx vitest run mcp/tools/practices.test.ts
node ../../scripts/check-mcp-parity.mjs
```
Expected: practices test PASS; parity check prints OK / exits 0 (tool names are unchanged, so no drift).

> If `mcp/tools/practices.test.ts` asserts on the old `frequency_type` field, update those assertions to the new columns as part of this step (mirror whatever Task 4's behaviour produces).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/mcp/tools/practices.ts
git commit -m "feat(practices): Tier 1 MCP tools use unified recurrence (parity)"
```

---

## Task 6: Tier 1 briefing context

**Files:**
- Modify: `supabase/functions/mcp/tools/briefings.ts:2,133-157` (and the practices SELECT)

- [ ] **Step 1: Update the import, SELECT, and mapping**

In `supabase/functions/mcp/tools/briefings.ts`:
- Change the import (`:2`) to `import { isPracticeDueOn, remainingThisPeriod, weekBoundaryStart } from '../../_shared/practices.ts'`.
- Update the practices SELECT to the new column list (same as Task 4 Step 2).
- Widen the completions fetch to the earlier of week-start / month-start (same `completionsFrom` logic as Task 4 Step 2).
- Replace the `practicesDue` mapping (`:133-137`) with the `completions_this_period` / `remaining_this_period` version from Task 4 Step 2.

- [ ] **Step 2: Run the briefings test**

Run:
```bash
cd supabase/functions && npx vitest run mcp/tools/briefings.test.ts
```
Expected: PASS. If the test fixtures use the old practice columns, update them to the new shape.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/mcp/tools/briefings.ts
git commit -m "feat(practices): Tier 1 briefing uses unified recurrence helpers"
```

---

## Task 7: Backend Hono route — zod schema + INSERT

**Files:**
- Modify: `backend/src/routes/api/practices.ts`

- [ ] **Step 1: Replace the zod input schema**

In `backend/src/routes/api/practices.ts`, replace the `FrequencyType`/`DayKey` enums and `PracticeInput` (`:10-25`) with:
```ts
const RecurrenceMode = z.enum(['pinned', 'flex_count'])
const Freq = z.enum(['daily', 'weekly', 'monthly'])
const DayCode = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
const FlexPeriod = z.enum(['week', 'month'])
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const RecurrenceRule = z.object({
  frequency: Freq,
  interval: z.number().int().min(1).optional(),
  days: z.array(DayCode).optional(),
})

const PracticeInput = z
  .object({
    name: z.string().min(1),
    category: Category,
    recurrence_mode: RecurrenceMode,
    recurrence_rule: RecurrenceRule.nullable().optional(),
    dtstart: IsoDate.nullable().optional(),
    recurrence_until: IsoDate.nullable().optional(),
    flex_period: FlexPeriod.nullable().optional(),
    flex_target: z.number().int().min(1).max(31).nullable().optional(),
    preferred_time_of_day: TimeOfDay.optional(),
    family_member_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (p) =>
      p.recurrence_mode === 'pinned'
        ? !!p.recurrence_rule && p.flex_period == null
        : p.flex_period != null && p.flex_target != null && p.recurrence_rule == null,
    { message: 'pinned requires recurrence_rule; flex_count requires flex_period + flex_target' },
  )
```
`PracticePatch` stays `PracticeInput.partial().extend({ active: z.boolean().optional() })` — but because `.refine` doesn't survive `.partial()`, define `PracticePatch` from the inner object instead:
```ts
const PracticePatch = z
  .object({
    name: z.string().min(1).optional(),
    category: Category.optional(),
    recurrence_mode: RecurrenceMode.optional(),
    recurrence_rule: RecurrenceRule.nullable().optional(),
    dtstart: IsoDate.nullable().optional(),
    recurrence_until: IsoDate.nullable().optional(),
    flex_period: FlexPeriod.nullable().optional(),
    flex_target: z.number().int().min(1).max(31).nullable().optional(),
    preferred_time_of_day: TimeOfDay.optional(),
    family_member_id: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
```

- [ ] **Step 2: Update the INSERT SQL in the POST handler**

Replace the `INSERT INTO plannen.practices (...)` column list + VALUES in the POST handler to match Task 4 Step 1's column set (`recurrence_mode, recurrence_rule, dtstart, recurrence_until, flex_period, flex_target, preferred_time_of_day`), passing `JSON.stringify(p.recurrence_rule)` for the JSONB column and `COALESCE($n::date, current_date)` for `dtstart`. (The PATCH handler builds its SET clause generically; confirm it serialises `recurrence_rule` with `JSON.stringify` if it passes objects — if it spreads the parsed body, wrap the `recurrence_rule` value in `JSON.stringify` before binding.)

- [ ] **Step 3: Build the backend to verify it compiles**

Run:
```bash
cd backend && npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/api/practices.ts
git commit -m "feat(practices): backend route validates unified recurrence"
```

---

## Task 8: Web dbClient type

**Files:**
- Modify: `src/lib/dbClient/types.ts:92-105`

- [ ] **Step 1: Replace the `PracticeRow` type**

In `src/lib/dbClient/types.ts`, replace the `PracticeRow` definition (`:92-105`) with:
```ts
export type PracticeRecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[] // MO,TU,WE,TH,FR,SA,SU
}

export type PracticeRow = Record<string, unknown> & {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  recurrence_mode: 'pinned' | 'flex_count'
  recurrence_rule: PracticeRecurrenceRule | null
  dtstart: string
  recurrence_until: string | null
  flex_period: 'week' | 'month' | null
  flex_target: number | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
  created_at: string
  updated_at: string
}
```
The tier0/tier1 dbClient bindings (`src/lib/dbClient/tier0.ts`, `tier1.ts`) pass inputs/outputs through generically and need no change. `PracticeCompletionRow` is unchanged.

- [ ] **Step 2: Type-check the web app**

Run:
```bash
npx tsc --noEmit
```
Expected: errors ONLY in `Today.tsx` and `ScheduleOverview.tsx` (they still read `frequency_type`/`target_count`). Those are fixed in Task 9. No other files should error.

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/types.ts
git commit -m "feat(practices): web PracticeRow type for unified recurrence"
```

---

## Task 9: Web UI labels + period-aware completion counts

**Files:**
- Create: `src/utils/practiceLabel.ts`
- Test: `src/utils/practiceLabel.test.ts`
- Modify: `src/components/Today.tsx`, `src/components/ScheduleOverview.tsx`

- [ ] **Step 1: Write the failing label test**

Create `src/utils/practiceLabel.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { practiceLabel } from './practiceLabel'
import type { PracticeRow } from '../lib/dbClient/types'

const base = {
  id: 'p', user_id: 'u', family_member_id: null, name: 'Meal prep',
  category: 'household' as const, dtstart: '2026-06-01', recurrence_until: null,
  preferred_time_of_day: 'anytime' as const, active: true,
  created_at: '', updated_at: '',
}

describe('practiceLabel', () => {
  it('flex_count week shows done/target', () => {
    const p: PracticeRow = { ...base, name: 'Gym', recurrence_mode: 'flex_count',
      recurrence_rule: null, flex_period: 'week', flex_target: 3 }
    expect(practiceLabel(p, 2)).toBe('Gym (2/3 this week)')
  })
  it('every-N-days shows the interval', () => {
    const p: PracticeRow = { ...base, recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily', interval: 2 }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Meal prep (every 2 days)')
  })
  it('plain daily shows (daily)', () => {
    const p: PracticeRow = { ...base, name: 'Vitamins', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Vitamins (daily)')
  })
  it('weekly shows the days', () => {
    const p: PracticeRow = { ...base, name: 'Walk', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'weekly', days: ['MO', 'WE', 'FR'] }, flex_period: null, flex_target: null }
    expect(practiceLabel(p, 0)).toBe('Walk (Mon/Wed/Fri)')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
npx vitest run src/utils/practiceLabel.test.ts
```
Expected: FAIL — `practiceLabel` does not exist.

- [ ] **Step 3: Implement the label + month-aware helpers**

Create `src/utils/practiceLabel.ts`:
```ts
import type { PracticeRow } from '../lib/dbClient/types'

const CODE_TO_NAME: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
}

/** "Gym (2/3 this week)", "Meal prep (every 2 days)", "Walk (Mon/Wed/Fri)". */
export function practiceLabel(p: PracticeRow, doneThisPeriod: number): string {
  if (p.recurrence_mode === 'flex_count') {
    return `${p.name} (${doneThisPeriod}/${p.flex_target ?? 0} this ${p.flex_period})`
  }
  const r = p.recurrence_rule
  if (!r) return p.name
  if (r.frequency === 'daily') {
    return (r.interval ?? 1) > 1 ? `${p.name} (every ${r.interval} days)` : `${p.name} (daily)`
  }
  if (r.frequency === 'weekly') {
    const days = (r.days ?? []).map((c) => CODE_TO_NAME[c] ?? c).join('/')
    return days ? `${p.name} (${days})` : p.name
  }
  if (r.frequency === 'monthly') return `${p.name} (monthly)`
  return p.name
}

/** Start of the calendar month for an ISO date, "YYYY-MM-01". */
export function monthStartIso(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** Start of the period this practice counts in, for an ISO date. */
export function practicePeriodStart(p: PracticeRow, weekStart: string, date: string): string {
  if (p.recurrence_mode === 'flex_count' && p.flex_period === 'month') return monthStartIso(date)
  return weekStart
}

/** Completions for `p` within its current period, given completions since month-start. */
export function doneThisPeriod(
  p: PracticeRow,
  completions: { practice_id: string; completed_on: string }[],
  weekStart: string,
  date: string,
): number {
  const from = practicePeriodStart(p, weekStart, date)
  return completions.filter(
    (c) => c.practice_id === p.id && c.completed_on >= from && c.completed_on <= date,
  ).length
}
```

- [ ] **Step 4: Run the label test to verify it passes**

Run:
```bash
npx vitest run src/utils/practiceLabel.test.ts
```
Expected: PASS.

- [ ] **Step 5: Wire `Today.tsx` to the helper + fetch since month-start**

In `src/components/Today.tsx`:
- Add import: `import { practiceLabel, doneThisPeriod, monthStartIso } from '../utils/practiceLabel'`.
- Change the completions fetch (`:35`) so the window covers month-period practices — fetch since the earlier of `weekStart(date)` and `monthStartIso(date)`:
```ts
const periodFrom = (() => { const ms = monthStartIso(date), ws = weekStart(date); return ms < ws ? ms : ws })()
// …
completionsThisWeek(periodFrom),   // the service param is just a "since" date
```
- Replace the label block (`:89-92`) with:
```ts
const weekDone = doneThisPeriod(p, completions, weekStart(date), date)
const label = practiceLabel(p, weekDone)
```

- [ ] **Step 6: Wire `RoutinesCard` in `ScheduleOverview.tsx` the same way**

In `src/components/ScheduleOverview.tsx`:
- Add the same import.
- Change its completions fetch (`:176`) to fetch since the earlier of `weekStartIso()` and `monthStartIso(date)`.
- Replace the label block (`:209-212`) with the same `doneThisPeriod` + `practiceLabel` two lines (use the card's `date`/`weekStartIso()`).

- [ ] **Step 7: Type-check + run the web test suite**

Run:
```bash
npx tsc --noEmit && npx vitest run
```
Expected: no type errors; all tests PASS (the `Today.tsx`/`ScheduleOverview.tsx` errors from Task 8 Step 2 are now resolved).

- [ ] **Step 8: Commit**

```bash
git add src/utils/practiceLabel.ts src/utils/practiceLabel.test.ts src/components/Today.tsx src/components/ScheduleOverview.tsx
git commit -m "feat(practices): render unified-recurrence labels with period-aware progress"
```

---

## Task 10: Agent guidance, full verification, and end-to-end smoke

**Files:**
- Modify: the `plannen-core` skill source (`plugin/skills/plannen-core/SKILL.md` or equivalent — locate with the grep below)

- [ ] **Step 1: Locate and update the agent guidance about practices vs events**

Run:
```bash
grep -rln "weekly_count\|frequency_type\|gym 3" plugin/ .claude/ docs/ 2>/dev/null
```
For each skill/doc hit that describes the OLD practice model, update the wording to the new model: practices are created with `recurrence_mode` (`pinned` with a `recurrence_rule` for every-N-days/weekdays/monthly, or `flex_count` with `flex_period`+`flex_target` for "N×/week"); time-pinned attendance (school drop-off) is still NOT a practice. Use only generic personas in any example ("Milo", "every other day", "gym 3×/week") — **no real names/schools** (repo is public).

- [ ] **Step 2: Run the full test + parity gates**

Run:
```bash
npm run test:run
node scripts/check-mcp-parity.mjs
cd mcp && npx vitest run && cd ..
cd supabase/functions && npx vitest run && cd ../..
```
Expected: all green; parity exits 0.

- [ ] **Step 3: End-to-end smoke against the live Tier 0 stack**

Ensure the stack is up (`npx plannen up` if needed), then create one practice of each flavor and read them back:
```bash
# meal prep every alternate day (pinned)
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
"INSERT INTO plannen.practices (user_id, name, category, recurrence_mode, recurrence_rule, dtstart)
 SELECT id, 'Meal prep', 'household', 'pinned', '{\"frequency\":\"daily\",\"interval\":2}', current_date
 FROM plannen.users LIMIT 1;"
# gym 3x/week (flex_count)
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
"INSERT INTO plannen.practices (user_id, name, category, recurrence_mode, flex_period, flex_target, dtstart)
 SELECT id, 'Gym', 'health', 'flex_count', 'week', 3, current_date
 FROM plannen.users LIMIT 1;"
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
"SELECT name, recurrence_mode, recurrence_rule, flex_period, flex_target FROM plannen.practices WHERE active;"
```
Expected: both rows insert (CHECK constraints satisfied) and read back with the correct columns. Then open the web app (`http://localhost:4321`) → the Routines card should show "Meal prep (every 2 days)" and "Gym (0/3 this week)". Tick Gym → label becomes "(1/3 this week)".

> Clean up the smoke rows afterward so they don't pollute real data:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
"DELETE FROM plannen.practices WHERE name IN ('Meal prep','Gym');"
```

- [ ] **Step 4: Commit + open PR**

```bash
git add plugin/ docs/ .claude/ 2>/dev/null; git commit -m "docs(practices): update agent guidance for unified recurrence"
git push -u origin design/unified-scheduling
gh pr create --title "Unified recurrence on practices (Phase 1)" \
  --body "Implements Phase 1 of docs/superpowers/specs/2026-06-10-unified-scheduling-design.md: pinned (every-N-days / weekdays / monthly) + flex_count (N per week/month) practices. No personal data. Phases 2 (attendances + blackouts) and 3 (linked obligations) follow as separate plans."
```

---

## Self-Review

**Spec coverage (Phase 1 portion of the design):**
- ✅ Two recurrence flavors (pinned RRULE-equivalent + flex_count) — Tasks 1, 2.
- ✅ Every-N-days / weekdays / monthly expressible — `occursOn` (Task 2), schema (Task 4).
- ✅ "This week" = ISO Monday-start; flex `month` = calendar month — Task 2 helpers.
- ✅ Clean-slate practice rework, no backfill (zero rows) — Task 1.
- ✅ Both MCP tiers in sync + parity guard — Tasks 4, 5, 10.
- ✅ Backend + web type + UI — Tasks 7, 8, 9.
- ✅ No personal data — generic personas enforced in Tasks 9, 10; spec already grep-clean.
- ⏭️ Attendances, blackout calendars, derived obligations, override resolution, intent-gate offer — **deliberately deferred** to the Phase 2 and Phase 3 plans (separate documents).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command states expected output.

**Type consistency:** `recurrence_mode`, `recurrence_rule` (`{frequency,interval,days}` with `MO..SU` codes), `dtstart`, `recurrence_until`, `flex_period`, `flex_target` are used identically across migration (Task 1), pure logic (Task 2/3), Tier 0 (Task 4), Tier 1 (Task 5/6), backend (Task 7), web type (Task 8), and UI (Task 9). Helper rename `remainingThisWeek → remainingThisPeriod` and briefing field rename `*_this_week → *_this_period` are applied in both tiers (Tasks 4 + 6). `occursOn`/`isPracticeDueOn`/`remainingThisPeriod`/`monthBoundaryStart` signatures match between `mcp/src/practices.ts` and `supabase/functions/_shared/practices.ts` (Task 3 Step 4 diff gate).
