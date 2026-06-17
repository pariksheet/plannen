# Routine Precise Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a routine optionally carry a precise start clock time (`HH:MM`) so it interleaves into the Today schedule at that time.

**Architecture:** Add a nullable `precise_time` column to `practices`; thread it through both MCP servers (parity) and the web type; sort/display timed routines in the web-only `routineToday.ts` + `ScheduleOverview.tsx`; add a form field. No change to the byte-identical scheduling engine mirror.

**Tech Stack:** Postgres (Supabase), Deno edge functions, Node MCP, React + TypeScript + Vitest, Tailwind.

## Global Constraints

- Repo is PUBLIC — no personal data in any file (use generic examples).
- `precise_time` format is `"HH:MM"` 24h, nullable; only meaningful for `pinned` routines.
- Precise time takes precedence over `preferred_time_of_day`; part-of-day is the fallback.
- MCP tools must stay in parity across `supabase/functions/mcp/tools/practices.ts` (edge) and `mcp/src/index.ts` (local). Tool names are unchanged.
- Do NOT add any shared `function`/`const` to the engine mirror (`practices.ts`/`scheduling.ts`); `routineToday.ts` is web-only and safe to edit.
- Migrations are forward-only and additive.
- Test commands:
  - web: `npx vitest run <path>`
  - edge: `npx vitest --config supabase/functions/vitest.config.ts run <path>`
  - local MCP: `npx vitest --config mcp/vitest.config.ts run <path>`
  - parity: `npm run check:parity`

---

### Task 1: DB migration — add `precise_time` column

**Files:**
- Create: `supabase/migrations/20260617130000_practice_precise_time.sql`

**Interfaces:**
- Produces: `plannen.practices.precise_time text NULL` (format `HH:MM`).

- [ ] **Step 1: Write the migration**

```sql
-- Optional precise clock time (HH:MM, 24h) for a routine. NULL = use
-- preferred_time_of_day only. Forward-only, additive.
alter table plannen.practices
  add column precise_time text;

alter table plannen.practices
  add constraint practices_precise_time_chk
    check (precise_time is null or precise_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
```

- [ ] **Step 2: Apply to the local/test DB**

Run: `npx plannen migrate`
Expected: migration applies cleanly, no error.

- [ ] **Step 3: Verify the column exists**

Run:
```bash
psql "$DATABASE_URL" -c "select column_name from information_schema.columns where table_schema='plannen' and table_name='practices' and column_name='precise_time';"
```
Expected: one row, `precise_time`. (If `$DATABASE_URL` is unset locally, this is verified in Task 7's deploy instead.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260617130000_practice_precise_time.sql
git commit -m "feat(db): add optional precise_time to practices"
```

---

### Task 2: Edge MCP — thread `precise_time` through practices tools

**Files:**
- Modify: `supabase/functions/mcp/tools/practices.ts`
- Test: `supabase/functions/mcp/tools/practices.test.ts` (create)

**Interfaces:**
- Consumes: `plannen.practices.precise_time` (Task 1).
- Produces: `create_practice`/`update_practice` accept optional `precise_time`; `list_practices` returns it.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/mcp/tools/practices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { practicesModule } from './practices.ts'

function recordingCtx() {
  const queries: { sql: string; params: unknown[] }[] = []
  const ctx = {
    client: {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params })
        return { rows: [{ id: 'p1' }], rowCount: 1 }
      },
    } as any,
    userId: 'u1',
  }
  return { ctx, queries }
}

describe('practices module — precise_time', () => {
  it('create_practice and update_practice schemas expose precise_time', () => {
    const create = practicesModule.definitions.find((d) => d.name === 'create_practice')!
    const update = practicesModule.definitions.find((d) => d.name === 'update_practice')!
    expect((create.inputSchema.properties as any).precise_time).toBeDefined()
    expect((update.inputSchema.properties as any).precise_time).toBeDefined()
  })

  it('create_practice INSERT includes precise_time and passes its value', async () => {
    const { ctx, queries } = recordingCtx()
    await practicesModule.dispatch.create_practice(
      { name: 'Brush', category: 'circle', recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' }, precise_time: '20:00' },
      ctx,
    )
    const insert = queries.find((q) => /INSERT INTO plannen\.practices/i.test(q.sql))!
    expect(insert.sql).toMatch(/precise_time/)
    expect(insert.params).toContain('20:00')
  })

  it('list_practices SELECT returns precise_time', async () => {
    const { ctx, queries } = recordingCtx()
    await practicesModule.dispatch.list_practices({}, ctx)
    const select = queries.find((q) => /FROM plannen\.practices/i.test(q.sql))!
    expect(select.sql).toMatch(/precise_time/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --config supabase/functions/vitest.config.ts run supabase/functions/mcp/tools/practices.test.ts`
Expected: FAIL (schema property undefined; INSERT/SELECT missing `precise_time`).

- [ ] **Step 3: Add `precise_time` to both tool schemas**

In `supabase/functions/mcp/tools/practices.ts`, in the `create_practice` properties (after the `preferred_time_of_day` line ~39) add:

```ts
        precise_time: { type: 'string', description: 'Optional precise start clock time "HH:MM" (24h, e.g. "20:00"). Only meaningful for pinned routines; overrides preferred_time_of_day for the schedule slot.' },
```

Add the identical line in the `update_practice` properties (after its `preferred_time_of_day` line ~68).

- [ ] **Step 4: Add `precise_time` to the create INSERT and the list SELECT**

Change the `createPractice` INSERT column list + VALUES + params:

```ts
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.practices
       (user_id, family_member_id, name, category, recurrence_mode,
        recurrence_rule, dtstart, recurrence_until, flex_period, flex_target,
        preferred_time_of_day, precise_time)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8, $9, $10, COALESCE($11, 'anytime'), $12)
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
      a.precise_time ?? null,
    ],
  )
```

Add `precise_time?: string | null` to the `createPractice` args cast type (the inline `a = args as {...}`).

Change the `listPractices` SELECT to add the column after `preferred_time_of_day`:

```ts
    `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
            dtstart::text, recurrence_until::text, flex_period, flex_target,
            preferred_time_of_day, precise_time, active, created_at, updated_at
     FROM plannen.practices
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`,
```

(`updatePractice` needs no change — its dynamic builder already forwards any field.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest --config supabase/functions/vitest.config.ts run supabase/functions/mcp/tools/practices.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/practices.ts supabase/functions/mcp/tools/practices.test.ts
git commit -m "feat(mcp-edge): accept and return precise_time on practices"
```

---

### Task 3: Local MCP — mirror `precise_time` (parity)

**Files:**
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Consumes: `plannen.practices.precise_time` (Task 1).
- Produces: local `create_practice`/`update_practice`/`list_practices` behave identically to edge (Task 2).

- [ ] **Step 1: Add `precise_time` to the `PracticeInput` type**

In `mcp/src/index.ts`, in `type PracticeInput = {…}` (line ~1961), after the `preferred_time_of_day` line add:

```ts
  precise_time?: string | null
```

- [ ] **Step 2: Add `precise_time` to the create INSERT and list SELECT**

In `listPractices` (line ~1949) change the SELECT to add `precise_time` after `preferred_time_of_day`:

```ts
      `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
              dtstart::text, recurrence_until::text, flex_period, flex_target,
              preferred_time_of_day, precise_time, active, created_at, updated_at
       FROM plannen.practices
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
```

In `createPractice` (INSERT at line ~1978) mirror Task 2 Step 4 exactly — add `precise_time` to the column list, `$12` to VALUES, and `args.precise_time ?? null,` to the params array.

- [ ] **Step 3: Add `precise_time` to both tool definitions**

In the `create_practice` definition (line ~3378) and `update_practice` definition (line ~3406) input-schema `properties`, add (after `preferred_time_of_day`):

```ts
        precise_time: { type: 'string', description: 'Optional precise start clock time "HH:MM" (24h, e.g. "20:00"). Only meaningful for pinned routines; overrides preferred_time_of_day for the schedule slot.' },
```

- [ ] **Step 4: Run parity check**

Run: `npm run check:parity`
Expected: PASS (tool names unchanged; no engine-function drift).

- [ ] **Step 5: Run the local MCP test suite**

Run: `npx vitest --config mcp/vitest.config.ts run`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp-local): mirror precise_time on practices (parity)"
```

---

### Task 4: Web type + sort/label logic

**Files:**
- Modify: `src/lib/dbClient/types.ts:98-114` (`PracticeRow`)
- Modify: `src/utils/routineToday.ts`
- Test: `src/utils/routineToday.test.ts` (extend)

**Interfaces:**
- Consumes: `PracticeRow.precise_time` from list_practices (Tasks 2/3).
- Produces:
  - `partOfDayMins(tod, preciseTime?: string | null): number`
  - `TodayRoutine` gains `timeLabel: string` (`"HH:MM"` when timed, else `""`).

- [ ] **Step 1: Add `precise_time` to `PracticeRow`**

In `src/lib/dbClient/types.ts`, in `PracticeRow` after `preferred_time_of_day: …` add:

```ts
  precise_time: string | null
```

- [ ] **Step 2: Write the failing tests**

Append to `src/utils/routineToday.test.ts`:

```ts
import { partOfDayMins } from './routineToday'

describe('partOfDayMins with precise_time', () => {
  it('returns minutes-of-day for a valid HH:MM, ignoring part-of-day', () => {
    expect(partOfDayMins('anytime', '20:00')).toBe(1200)
    expect(partOfDayMins('morning', '06:30')).toBe(390)
  })
  it('falls back to part-of-day when precise_time is null or invalid', () => {
    expect(partOfDayMins('morning', null)).toBe(480)
    expect(partOfDayMins('evening', '99:99')).toBe(1080)
    expect(partOfDayMins('anytime')).toBe(Number.POSITIVE_INFINITY)
  })
  it('a timed routine sorts between two events by minutes', () => {
    const eventA = 18 * 60 + 15 // 1095
    const eventB = 21 * 60      // 1260
    const routine = partOfDayMins('anytime', '20:00') // 1200
    expect(eventA).toBeLessThan(routine)
    expect(routine).toBeLessThan(eventB)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/utils/routineToday.test.ts`
Expected: FAIL (`partOfDayMins` ignores the 2nd arg).

- [ ] **Step 4: Implement `partOfDayMins` + `timeLabel`**

In `src/utils/routineToday.ts`:

Add `timeLabel: string` to the `TodayRoutine` type.

Replace `partOfDayMins` with:

```ts
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Part-of-day → a synthetic minutes-of-day sort key so routines interleave
 *  among the day's timed items. A valid precise_time wins; `anytime` sorts last. */
export function partOfDayMins(
  tod: PracticeRow['preferred_time_of_day'],
  preciseTime?: string | null,
): number {
  if (preciseTime && HHMM.test(preciseTime)) {
    const [h, m] = preciseTime.split(':').map(Number)
    return h * 60 + m
  }
  switch (tod) {
    case 'morning': return 480    // 08:00
    case 'afternoon': return 780  // 13:00
    case 'evening': return 1080   // 18:00
    default: return Number.POSITIVE_INFINITY // anytime → end of day
  }
}
```

In `applicableTodayRoutines`, update the mapped object to set `timeLabel` and pass `precise_time` to `partOfDayMins`:

```ts
    .map((p) => ({
      id: p.id,
      label: practiceLabel(p, doneThisPeriod(p, completions, weekStart, date)),
      done: completions.some((c) => c.practice_id === p.id && c.completed_on === date),
      sortMins: partOfDayMins(p.preferred_time_of_day, p.precise_time),
      timeLabel: p.precise_time && HHMM.test(p.precise_time) ? p.precise_time : '',
    }))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/utils/routineToday.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dbClient/types.ts src/utils/routineToday.ts src/utils/routineToday.test.ts
git commit -m "feat(web): precise_time sort key + timeLabel for routines"
```

---

### Task 5: Web render — show the routine's time in the schedule row

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` (routine row ~554-564; `WeekRow` routine variant type)

**Interfaces:**
- Consumes: `TodayRoutine.timeLabel` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/components/ScheduleOverview.routine-time.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/useTodayRoutines', () => ({
  useTodayRoutines: () => ({
    routines: [{ id: 'r1', label: 'Brush Niheet Before Sleep (daily)', done: false, sortMins: 1200, timeLabel: '20:00' }],
    toggle: vi.fn(),
  }),
}))
vi.mock('../services/weatherService', () => ({ getTodayWeather: () => Promise.resolve(null) }))
vi.mock('../services/locationService', () => ({ getLocations: () => Promise.resolve({ data: [] }) }))

import { ScheduleOverview } from './ScheduleOverview'

const noop = () => {}
const actions = { onEdit: noop, onDelete: noop, onShareSuccess: noop, onHashtagClick: noop } as any

describe('ScheduleOverview routine time', () => {
  it('renders a timed routine with its HH:MM label', async () => {
    render(<ScheduleOverview events={[]} {...actions} />)
    expect(await screen.findByText('20:00')).toBeInTheDocument()
    expect(screen.getByText(/Brush Niheet Before Sleep/)).toBeInTheDocument()
  })
})
```

(If `getLocations` lives in a different module, match the import used by `HeaderStrip` in `ScheduleOverview.tsx`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.routine-time.test.tsx`
Expected: FAIL (no `20:00` text rendered).

- [ ] **Step 3: Render `timeLabel` in the routine row**

In `src/components/ScheduleOverview.tsx`, the routine `<label>` (around line 554), add a muted time span before the name span:

```tsx
                  {r.timeLabel && (
                    <span className="text-gray-500 text-sm whitespace-nowrap mr-2">{r.timeLabel}</span>
                  )}
                  <span className={r.done ? 'line-through text-gray-400' : ''}>{r.label}</span>
```

Add `timeLabel: string` to the routine variant of the `WeekRow` type if it enumerates routine fields (otherwise `row.routine` already carries it from `TodayRoutine`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ScheduleOverview.routine-time.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.routine-time.test.tsx
git commit -m "feat(web): show routine clock time in the schedule row"
```

---

### Task 6: Web form — set a precise time (pinned only)

**Files:**
- Modify: `src/components/ProfileRoutines.tsx`

**Interfaces:**
- Consumes: `PracticeRow.precise_time` (Task 4); `partOfDayMins` not used here.
- Produces: form writes `precise_time` via `buildPatch()`.

- [ ] **Step 1: Add `precise_time` to `FormState` and `EMPTY_FORM`**

In `FormState` add `precise_time: string | null`. In `EMPTY_FORM` add `precise_time: null,`.

- [ ] **Step 2: Populate it in `startEdit`**

In `startEdit`'s `setForm({…})` add:

```ts
      precise_time: p.precise_time ?? null,
```

- [ ] **Step 3: Write it in `buildPatch`**

In `buildPatch`, inside the `if (form.recurrence_mode === 'pinned') {` branch set the time, and in the `else` branch clear it:

```ts
    if (form.recurrence_mode === 'pinned') {
      patch.recurrence_rule =
        form.frequency === 'daily'
          ? { frequency: 'daily' }
          : { frequency: 'weekly', days: form.days }
      patch.flex_period = null
      patch.flex_target = null
      patch.precise_time = form.precise_time || null
    } else {
      patch.recurrence_rule = null
      patch.flex_period = form.flex_period
      patch.flex_target = form.flex_target
      patch.precise_time = null
    }
```

- [ ] **Step 4: Add the time input (pinned only)**

In the `form.recurrence_mode === 'pinned'` JSX block (after the weekday picker, before its closing `</div>` at line ~363) add:

```tsx
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Time (optional)</label>
                        <input
                          type="time"
                          aria-label="Precise time"
                          value={form.precise_time ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, precise_time: e.target.value || null }))}
                          className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
```

- [ ] **Step 5: Show the time in the settings list row**

In `describe(p)` add, before the final `return`, a precise-time suffix for pinned routines. Change the daily/weekly returns to append the time when set — simplest: at the top of `describe`, compute `const at = p.precise_time ? ` · ${p.precise_time}` : ''` and append `at` to each pinned branch's return string (`'Every day' + at`, `\`Weekly · ${labels}\` + at`).

- [ ] **Step 6: Typecheck + run the web suite**

Run: `npx tsc --noEmit && npx vitest run src/components/ProfileRoutines.test.tsx`
Expected: PASS (or no test file → `--passWithNoTests`; add a minimal render assertion if a test file exists).

- [ ] **Step 7: Commit**

```bash
git add src/components/ProfileRoutines.tsx
git commit -m "feat(web): routine form accepts an optional precise time"
```

---

### Task 7: Full verification + rollout

**Files:** none (process task).

- [ ] **Step 1: Backup before any DB change to a live profile**

Run: `bash scripts/export-seed.sh`
Expected: writes `supabase/seed.sql` + photos tarball.

- [ ] **Step 2: Run every affected suite + parity**

Run:
```bash
npx tsc --noEmit
npm run test:run
npx vitest --config supabase/functions/vitest.config.ts run
npx vitest --config mcp/vitest.config.ts run
npm run check:parity
```
Expected: all green.

- [ ] **Step 3: Apply the migration to the active (cloud) profile**

Run: `npx plannen migrate`
Expected: `20260617130000_practice_precise_time.sql` applied; no error.

- [ ] **Step 4: Deploy edge function + web**

Run: `npx plannen deploy`
Expected: deploy succeeds; stable alias resolved.

- [ ] **Step 5: Manual smoke check**

In the web app: edit "Brush Niheet Before Sleep", set time `20:00`, save. Confirm it shows `20:00` in My Routines and interleaves at 20:00 in the Today schedule (after the 18:15 item).

- [ ] **Step 6: Final commit (if any docs/touch-ups remain)**

```bash
git add -A && git commit -m "chore: routine precise time — verification notes" || true
```
