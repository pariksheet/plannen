# Daily Plan Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the family-aware (circle-aware) daily plan: a new `practices` data model, MCP tools, a plugin skill + slash command (`/plannen-today`), and a new `/today` web surface that replaces MyFeed as default landing.

**Architecture:** Three new tables in `plannen.*` schema. Claude is the brain — it composes the briefing via a plugin skill, using a composite MCP tool (`get_briefing_context`) plus a write tool (`save_daily_briefing`). The web `/today` view is a passive viewer + practice checkboxes; no AI calls from the web in v1. Tier 0 path goes through the Hono backend + Supabase-compatible REST; Tier 1 path goes through supabase-js with RLS.

**Tech Stack:** PostgreSQL (`plannen.*` schema) · TypeScript MCP server (`mcp/src/`) · Hono + Zod backend (`backend/src/`) · React + React Router (`src/`) · vitest

**Spec:** [`docs/superpowers/specs/2026-05-19-daily-plan-agent-design.md`](../specs/2026-05-19-daily-plan-agent-design.md)

---

## Phase 1 — Schema + Helper Logic

### Task 1: Add daily-plan migration

**Files:**
- Create: `supabase/migrations/20260519120000_daily_plan_agent.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Daily plan agent: practices, practice_completions, daily_briefings.
-- Forward-only additive migration. All tables live in plannen.* schema and
-- are RLS-scoped to auth.uid().

create table plannen.practices (
  id              uuid primary key default extensions.uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  name            text not null,
  category        text not null
                    check (category in ('health','household','circle','focus','other')),
  frequency_type  text not null
                    check (frequency_type in ('daily','weekly_count','specific_days')),
  target_count    integer
                    check (target_count is null or target_count between 1 and 7),
  days_of_week    text[]
                    check (days_of_week is null or days_of_week <@ array['mon','tue','wed','thu','fri','sat','sun']::text[]),
  preferred_time_of_day text not null default 'anytime'
                    check (preferred_time_of_day in ('morning','afternoon','evening','anytime')),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index practices_user_active on plannen.practices(user_id) where active;

alter table plannen.practices enable row level security;
create policy "practices: owner only" on plannen.practices
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table plannen.practice_completions (
  id              uuid primary key default extensions.uuid_generate_v4(),
  practice_id     uuid not null references plannen.practices(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  completed_on    date not null,
  created_at      timestamptz not null default now()
);

create index practice_completions_practice_date
  on plannen.practice_completions(practice_id, completed_on desc);

create index practice_completions_user
  on plannen.practice_completions(user_id);

-- Two partial unique indexes (one for non-null family_member_id, one for null)
-- because Postgres treats NULLs as distinct in a single UNIQUE — which would
-- silently break idempotency for self-owned practices.
create unique index practice_completions_uniq_member
  on plannen.practice_completions (practice_id, completed_on, family_member_id)
  where family_member_id is not null;
create unique index practice_completions_uniq_self
  on plannen.practice_completions (practice_id, completed_on)
  where family_member_id is null;

alter table plannen.practice_completions enable row level security;
create policy "practice_completions: owner only" on plannen.practice_completions
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table plannen.daily_briefings (
  id              uuid primary key default extensions.uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  briefing_date   date not null,
  content_md      text not null,
  summary         text,
  source          text not null
                    check (source in ('claude_code','claude_desktop','web','cron')),
  generated_at    timestamptz not null default now(),
  unique (user_id, briefing_date)
);

create index daily_briefings_user_date on plannen.daily_briefings(user_id, briefing_date desc);

alter table plannen.daily_briefings enable row level security;
create policy "daily_briefings: owner only" on plannen.daily_briefings
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at touch trigger for practices (reuses existing helper if present).
create or replace function plannen.touch_practices_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger practices_touch_updated_at
  before update on plannen.practices
  for each row execute function plannen.touch_practices_updated_at();

grant all on table plannen.practices            to anon, authenticated, service_role;
grant all on table plannen.practice_completions to anon, authenticated, service_role;
grant all on table plannen.daily_briefings      to anon, authenticated, service_role;
grant all on function plannen.touch_practices_updated_at() to anon, authenticated, service_role;
```

- [ ] **Step 2: Apply migration**

Run: `npx plannen migrate`
Expected: log line confirming `20260519120000_daily_plan_agent.sql` applied; no errors. (This verb resolves the active profile, applies tier-appropriate migrations, and wraps the underlying `scripts/lib/migrate.mjs`.)

- [ ] **Step 3: Verify schema**

Run: `psql "$DATABASE_URL" -c "\dt plannen.practices plannen.practice_completions plannen.daily_briefings"`
Expected: three rows listing the new tables.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260519120000_daily_plan_agent.sql
git commit -m "feat(schema): practices, practice_completions, daily_briefings"
```

---

### Task 2: Practices helper module + tests

Pure logic — week boundaries and "due-today" math. Isolated from DB so it can be tested fast.

**Files:**
- Create: `mcp/src/practices.ts`
- Test: `mcp/src/practices.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// mcp/src/practices.test.ts
import { describe, it, expect } from 'vitest'
import {
  weekBoundaryStart,
  dayOfWeekKey,
  isPracticeDueOn,
  remainingThisWeek,
  type PracticeRow,
  type CompletionRow,
} from './practices.js'

function practice(p: Partial<PracticeRow>): PracticeRow {
  return {
    id: p.id ?? 'p1',
    user_id: p.user_id ?? 'u1',
    family_member_id: p.family_member_id ?? null,
    name: p.name ?? 'Gym',
    category: p.category ?? 'health',
    frequency_type: p.frequency_type ?? 'daily',
    target_count: p.target_count ?? null,
    days_of_week: p.days_of_week ?? null,
    preferred_time_of_day: p.preferred_time_of_day ?? 'anytime',
    active: p.active ?? true,
  }
}

describe('weekBoundaryStart', () => {
  it('returns Monday for a Wednesday', () => {
    expect(weekBoundaryStart('2026-05-20')).toBe('2026-05-18')
  })
  it('returns Monday for a Sunday (boundary day)', () => {
    // 2026-05-24 is Sunday. Week boundary = Mon 2026-05-18.
    expect(weekBoundaryStart('2026-05-24')).toBe('2026-05-18')
  })
  it('returns same date when called on Monday', () => {
    expect(weekBoundaryStart('2026-05-18')).toBe('2026-05-18')
  })
})

describe('dayOfWeekKey', () => {
  it('maps Monday 2026-05-18 to "mon"', () => {
    expect(dayOfWeekKey('2026-05-18')).toBe('mon')
  })
  it('maps Saturday 2026-05-23 to "sat"', () => {
    expect(dayOfWeekKey('2026-05-23')).toBe('sat')
  })
})

describe('isPracticeDueOn', () => {
  it('daily practice is due every day', () => {
    const p = practice({ frequency_type: 'daily' })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(true)
  })
  it('weekly_count practice is due if remaining > 0', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 3 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
    ]
    expect(isPracticeDueOn(p, '2026-05-20', completions)).toBe(true)
  })
  it('weekly_count practice is NOT due when target met', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 2 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
    ]
    expect(isPracticeDueOn(p, '2026-05-20', completions)).toBe(false)
  })
  it('specific_days practice respects days_of_week', () => {
    const p = practice({ frequency_type: 'specific_days', days_of_week: ['mon', 'wed', 'fri'] })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(true)  // Wednesday
    expect(isPracticeDueOn(p, '2026-05-21', [])).toBe(false) // Thursday
  })
  it('inactive practice never due', () => {
    const p = practice({ active: false })
    expect(isPracticeDueOn(p, '2026-05-20', [])).toBe(false)
  })
})

describe('remainingThisWeek', () => {
  it('returns null for daily practice', () => {
    const p = practice({ frequency_type: 'daily' })
    expect(remainingThisWeek(p, '2026-05-20', [])).toBeNull()
  })
  it('counts only completions in the current week', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 3 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-17' }, // last week (Sun)
      { practice_id: 'p1', completed_on: '2026-05-18' }, // this week Mon
      { practice_id: 'p1', completed_on: '2026-05-19' }, // this week Tue
    ]
    expect(remainingThisWeek(p, '2026-05-20', completions)).toBe(1)
  })
  it('floors at 0 when over-completed', () => {
    const p = practice({ frequency_type: 'weekly_count', target_count: 2 })
    const completions: CompletionRow[] = [
      { practice_id: 'p1', completed_on: '2026-05-18' },
      { practice_id: 'p1', completed_on: '2026-05-19' },
      { practice_id: 'p1', completed_on: '2026-05-20' },
    ]
    expect(remainingThisWeek(p, '2026-05-20', completions)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npx vitest run src/practices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// mcp/src/practices.ts
// Pure helpers for the daily-plan agent. No DB / IO. All dates are ISO
// "YYYY-MM-DD" strings in the user's local timezone — timezone resolution
// happens at the caller boundary.

export type PracticeRow = {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  frequency_type: 'daily' | 'weekly_count' | 'specific_days'
  target_count: number | null
  days_of_week: string[] | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
}

export type CompletionRow = {
  practice_id: string
  completed_on: string // YYYY-MM-DD
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** ISO weekday: Mon=1..Sun=7. Date string is "YYYY-MM-DD". */
function weekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`)
  const js = d.getUTCDay() // 0=Sun..6=Sat
  return js === 0 ? 7 : js
}

/** Returns the Monday of the ISO week containing `date`, as "YYYY-MM-DD". */
export function weekBoundaryStart(date: string): string {
  const wd = weekday(date)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

/** "mon"/"tue"/.../"sun" for an ISO date. */
export function dayOfWeekKey(date: string): typeof DAY_KEYS[number] {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay()
  return DAY_KEYS[js]
}

function completionsInWeekOf(practice: PracticeRow, date: string, completions: CompletionRow[]): number {
  const start = weekBoundaryStart(date)
  const startD = new Date(`${start}T00:00:00Z`).getTime()
  const endD = startD + 7 * 24 * 3600 * 1000 // exclusive
  return completions.filter((c) => {
    if (c.practice_id !== practice.id) return false
    const t = new Date(`${c.completed_on}T00:00:00Z`).getTime()
    return t >= startD && t < endD
  }).length
}

export function isPracticeDueOn(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): boolean {
  if (!practice.active) return false
  switch (practice.frequency_type) {
    case 'daily':
      return true
    case 'weekly_count': {
      const target = practice.target_count ?? 0
      return completionsInWeekOf(practice, date, completions) < target
    }
    case 'specific_days': {
      const today = dayOfWeekKey(date)
      return practice.days_of_week?.includes(today) ?? false
    }
  }
}

/** Remaining completions needed this week (null for non-weekly-count). */
export function remainingThisWeek(
  practice: PracticeRow,
  date: string,
  completions: CompletionRow[],
): number | null {
  if (practice.frequency_type !== 'weekly_count') return null
  const done = completionsInWeekOf(practice, date, completions)
  const target = practice.target_count ?? 0
  return Math.max(0, target - done)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npx vitest run src/practices.test.ts`
Expected: PASS — 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/practices.ts mcp/src/practices.test.ts
git commit -m "feat(mcp): practices helper — frequency-due math + week-boundary"
```

---

## Phase 2 — MCP Server

### Task 3: Practices CRUD MCP handlers + tools

**Files:**
- Modify: `mcp/src/index.ts` — add handlers, TOOLS entries, switch cases.

- [ ] **Step 1: Add handler functions**

Append the following before the `TOOLS` array (around line 1500). Use the existing `addFamilyMember` / `listFamilyMembers` (lines 1096-1139) as the pattern.

```ts
// ── Practices ─────────────────────────────────────────────────────────────────

async function listPractices(args: { active_only?: boolean; family_member_id?: string | null } = {}) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [id]
    if (args.active_only) where.push('active = true')
    if (args.family_member_id !== undefined) {
      params.push(args.family_member_id)
      where.push(`family_member_id ${args.family_member_id === null ? 'IS NULL' : '= $' + params.length}`)
    }
    const { rows } = await c.query(
      `SELECT id, family_member_id, name, category, frequency_type, target_count,
              days_of_week, preferred_time_of_day, active, created_at, updated_at
       FROM plannen.practices
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
      params,
    )
    return rows
  })
}

type PracticeInput = {
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  frequency_type: 'daily' | 'weekly_count' | 'specific_days'
  target_count?: number | null
  days_of_week?: string[] | null
  preferred_time_of_day?: 'morning' | 'afternoon' | 'evening' | 'anytime'
  family_member_id?: string | null
}

async function createPractice(args: PracticeInput) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.practices
         (user_id, family_member_id, name, category, frequency_type,
          target_count, days_of_week, preferred_time_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'anytime'))
       RETURNING *`,
      [
        id,
        args.family_member_id ?? null,
        args.name,
        args.category,
        args.frequency_type,
        args.target_count ?? null,
        args.days_of_week ?? null,
        args.preferred_time_of_day ?? null,
      ],
    )
    return rows[0]
  })
}

async function updatePractice(args: { id: string } & Partial<PracticeInput> & { active?: boolean }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const sets: string[] = []
    const params: unknown[] = []
    for (const [k, v] of Object.entries(args)) {
      if (k === 'id') continue
      params.push(v)
      sets.push(`${k} = $${params.length}`)
    }
    if (sets.length === 0) throw new Error('no fields to update')
    params.push(args.id, userId)
    const { rows } = await c.query(
      `UPDATE plannen.practices SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new Error('practice not found')
    return rows[0]
  })
}

async function deletePractice(args: { id: string }) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE plannen.practices SET active = false
       WHERE id = $1 AND user_id = $2`,
      [args.id, userId],
    )
    if (rowCount === 0) throw new Error('practice not found')
    return { ok: true }
  })
}
```

- [ ] **Step 2: Register tools**

Append to the `TOOLS: Tool[]` array (anywhere; keep grouped):

```ts
{
  name: 'list_practices',
  description: 'List your practices (frequency-flex recurring intentions like gym 3×/week, vitamin D daily). Returns rows with frequency_type, target_count, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      active_only: { type: 'boolean', description: 'Only return active=true rows (default false).' },
      family_member_id: { type: 'string', description: 'Filter to practices owned by this circle member. Pass null for unowned (self).' },
    },
  },
},
{
  name: 'create_practice',
  description: 'Create a new practice. Use this for recurring intentions that are NOT time-pinned events — gym 3×/week, vitamins daily, dishes 2×/week. Fixed-time recurrences (drop kids at school 08:15) should be recurring events instead.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
      frequency_type: { type: 'string', enum: ['daily', 'weekly_count', 'specific_days'] },
      target_count: { type: 'number', description: 'Required when frequency_type=weekly_count. Integer 1–7.' },
      days_of_week: { type: 'array', items: { type: 'string', enum: ['mon','tue','wed','thu','fri','sat','sun'] }, description: 'Required when frequency_type=specific_days.' },
      preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
      family_member_id: { type: 'string', description: 'Optional — owner is a circle member rather than the user themselves.' },
    },
    required: ['name', 'category', 'frequency_type'],
  },
},
{
  name: 'update_practice',
  description: 'Update fields on an existing practice.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string', enum: ['health', 'household', 'circle', 'focus', 'other'] },
      frequency_type: { type: 'string', enum: ['daily', 'weekly_count', 'specific_days'] },
      target_count: { type: 'number' },
      days_of_week: { type: 'array', items: { type: 'string' } },
      preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
      family_member_id: { type: ['string', 'null'] },
      active: { type: 'boolean' },
    },
    required: ['id'],
  },
},
{
  name: 'delete_practice',
  description: 'Soft-delete a practice (sets active=false). The row is preserved so historical completion stats remain meaningful.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
},
```

- [ ] **Step 3: Add switch cases**

Insert in the dispatcher switch (around line 2090, near other case labels):

```ts
case 'list_practices':   result = await listPractices(args as Parameters<typeof listPractices>[0]); break
case 'create_practice':  result = await createPractice(args as Parameters<typeof createPractice>[0]); break
case 'update_practice':  result = await updatePractice(args as Parameters<typeof updatePractice>[0]); break
case 'delete_practice':  result = await deletePractice(args as Parameters<typeof deletePractice>[0]); break
```

- [ ] **Step 4: Smoke check (typecheck)**

Run: `cd mcp && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): list/create/update/delete practice tools"
```

---

### Task 4: practice_completions MCP handlers + tools

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add handler functions** (append after the practice CRUD block from Task 3)

```ts
async function markPracticeDone(args: {
  practice_id: string
  completed_on?: string
  family_member_id?: string | null
}) {
  const userId = await uid()
  const date = args.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    // Verify ownership (RLS handles it, but a 404 is friendlier than a silent no-op).
    const { rowCount: owns } = await c.query(
      `SELECT 1 FROM plannen.practices WHERE id = $1 AND user_id = $2`,
      [args.practice_id, userId],
    )
    if (owns === 0) throw new Error('practice not found')
    // The schema has TWO partial unique indexes (one where family_member_id is
    // NOT NULL, one where it IS NULL) because Postgres treats NULLs as distinct
    // in a single UNIQUE constraint. ON CONFLICT without a target lets Postgres
    // pick whichever partial index matches the row being inserted.
    await c.query(
      `INSERT INTO plannen.practice_completions
         (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [args.practice_id, userId, args.family_member_id ?? null, date],
    )
    return { ok: true, practice_id: args.practice_id, completed_on: date }
  })
}

async function unmarkPracticeDone(args: {
  practice_id: string
  completed_on?: string
  family_member_id?: string | null
}) {
  const userId = await uid()
  const date = args.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    await c.query(
      `DELETE FROM plannen.practice_completions
       WHERE practice_id = $1
         AND user_id = $2
         AND completed_on = $3
         AND family_member_id IS NOT DISTINCT FROM $4`,
      [args.practice_id, userId, date, args.family_member_id ?? null],
    )
    return { ok: true, practice_id: args.practice_id, completed_on: date }
  })
}
```

- [ ] **Step 2: Register tools**

Append to TOOLS array:

```ts
{
  name: 'mark_practice_done',
  description: 'Log a completion for a practice on a date (defaults to today). Idempotent — calling twice on the same date is a no-op. Pass family_member_id when the practice is owned by a circle member.',
  inputSchema: {
    type: 'object',
    properties: {
      practice_id: { type: 'string' },
      completed_on: { type: 'string', description: 'ISO date YYYY-MM-DD; defaults to today.' },
      family_member_id: { type: ['string', 'null'] },
    },
    required: ['practice_id'],
  },
},
{
  name: 'unmark_practice_done',
  description: 'Remove a logged completion (undo).',
  inputSchema: {
    type: 'object',
    properties: {
      practice_id: { type: 'string' },
      completed_on: { type: 'string' },
      family_member_id: { type: ['string', 'null'] },
    },
    required: ['practice_id'],
  },
},
```

- [ ] **Step 3: Add switch cases**

```ts
case 'mark_practice_done':   result = await markPracticeDone(args as Parameters<typeof markPracticeDone>[0]); break
case 'unmark_practice_done': result = await unmarkPracticeDone(args as Parameters<typeof unmarkPracticeDone>[0]); break
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd mcp && npx tsc --noEmit`

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): mark/unmark practice_done tools"
```

---

### Task 5: `get_briefing_context` MCP handler + tool

The composite read tool — Claude calls this once and gets everything needed for the briefing.

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add handler** (after practice handlers)

```ts
async function getBriefingContext(args: { date?: string } = {}) {
  const userId = await uid()
  const today = args.date ?? new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`)
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7)
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10)
  const weekStart = (await import('./practices.js')).weekBoundaryStart(today)

  return await withUserContext(userId, async (c) => {
    const [user, circle, eventsToday, eventsTomorrow, recentPast, practices, completionsThisWeek, locations] =
      await Promise.all([
        c.query(
          `SELECT user_id AS id, display_name, timezone, locale FROM plannen.profiles WHERE user_id = $1`,
          [userId],
        ),
        c.query(
          `SELECT id, name, relation, dob, gender, goals, interests
           FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        c.query(
          `SELECT id, title, start_date, end_date, location, event_kind, hashtags
           FROM plannen.events
           WHERE created_by = $1 AND start_date::date = $2::date
           ORDER BY start_date ASC`,
          [userId, today],
        ),
        c.query(
          `SELECT id, title, start_date, end_date, location, event_kind, hashtags
           FROM plannen.events
           WHERE created_by = $1 AND start_date::date = $2::date
           ORDER BY start_date ASC`,
          [userId, tomorrowStr],
        ),
        c.query(
          `SELECT id, title, start_date, location, event_kind
           FROM plannen.events
           WHERE created_by = $1
             AND start_date::date BETWEEN $2::date AND ($3::date - INTERVAL '1 day')::date
           ORDER BY start_date DESC LIMIT 10`,
          [userId, sevenDaysAgoStr, today],
        ),
        c.query(
          `SELECT id, family_member_id, name, category, frequency_type, target_count,
                  days_of_week, preferred_time_of_day, active
           FROM plannen.practices WHERE user_id = $1 AND active = true`,
          [userId],
        ),
        c.query(
          `SELECT practice_id, completed_on::text
           FROM plannen.practice_completions
           WHERE user_id = $1 AND completed_on >= $2::date`,
          [userId, weekStart],
        ),
        c.query(
          `SELECT id, label, city, country, is_default
           FROM plannen.user_locations WHERE user_id = $1`,
          [userId],
        ),
      ])

    const { isPracticeDueOn, remainingThisWeek } = await import('./practices.js')
    type CRow = { practice_id: string; completed_on: string }
    const allCompletions = completionsThisWeek.rows as CRow[]
    const practicesDue = (practices.rows as Parameters<typeof isPracticeDueOn>[0][])
      .filter((p) => isPracticeDueOn(p, today, allCompletions))
      .map((p) => {
        const inWeek = allCompletions.filter((c) => c.practice_id === p.id).length
        return {
          ...p,
          completions_this_week: inWeek,
          remaining_this_week: remainingThisWeek(p, today, allCompletions),
        }
      })

    const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long', timeZone: 'UTC',
    })

    return {
      date: today,
      weekday,
      user: user.rows[0] ?? { id: userId },
      circle: circle.rows,
      events_today: eventsToday.rows,
      events_tomorrow: eventsTomorrow.rows,
      recent_past_events: recentPast.rows,
      practices_due_today: practicesDue,
      locations: locations.rows,
    }
  })
}
```

- [ ] **Step 2: Register tool**

```ts
{
  name: 'get_briefing_context',
  description: 'Composite snapshot for composing the daily briefing — events today + tomorrow, recent past events, your circle, practices due today (with weekly remaining counts), and locations. One round-trip. Use this before composing a /plannen-today briefing.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'ISO date; defaults to today.' },
    },
  },
},
```

- [ ] **Step 3: Add switch case**

```ts
case 'get_briefing_context': result = await getBriefingContext(args as Parameters<typeof getBriefingContext>[0]); break
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd mcp && npx tsc --noEmit
git add -p mcp/src/index.ts
git commit -m "feat(mcp): get_briefing_context composite read"
```

---

### Task 6: `save_daily_briefing` + `get_daily_briefing` MCP handlers + tools

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add handlers**

```ts
async function saveDailyBriefing(args: {
  briefing_date: string
  content_md: string
  summary?: string | null
  source: 'claude_code' | 'claude_desktop' | 'web' | 'cron'
}) {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO plannen.daily_briefings
         (user_id, briefing_date, content_md, summary, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, briefing_date) DO UPDATE
         SET content_md = EXCLUDED.content_md,
             summary = EXCLUDED.summary,
             source = EXCLUDED.source,
             generated_at = now()
       RETURNING *`,
      [userId, args.briefing_date, args.content_md, args.summary ?? null, args.source],
    )
    return rows[0]
  })
}

async function getDailyBriefing(args: { date?: string } = {}) {
  const userId = await uid()
  const date = args.date ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, briefing_date::text, content_md, summary, source, generated_at
       FROM plannen.daily_briefings
       WHERE user_id = $1 AND briefing_date = $2::date`,
      [userId, date],
    )
    return rows[0] ?? null
  })
}
```

- [ ] **Step 2: Register tools**

```ts
{
  name: 'save_daily_briefing',
  description: 'Persist the composed daily briefing. Upserts on (user_id, briefing_date) — a second save on the same date overwrites. Content is markdown.',
  inputSchema: {
    type: 'object',
    properties: {
      briefing_date: { type: 'string' },
      content_md: { type: 'string' },
      summary: { type: 'string' },
      source: { type: 'string', enum: ['claude_code', 'claude_desktop', 'web', 'cron'] },
    },
    required: ['briefing_date', 'content_md', 'source'],
  },
},
{
  name: 'get_daily_briefing',
  description: 'Fetch the persisted briefing for a date (default today). Returns null if none exists.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'ISO date; defaults to today.' },
    },
  },
},
```

- [ ] **Step 3: Add switch cases**

```ts
case 'save_daily_briefing': result = await saveDailyBriefing(args as Parameters<typeof saveDailyBriefing>[0]); break
case 'get_daily_briefing':  result = await getDailyBriefing(args as Parameters<typeof getDailyBriefing>[0]); break
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd mcp && npx tsc --noEmit
git add mcp/src/index.ts
git commit -m "feat(mcp): save/get daily_briefing tools"
```

---

## Phase 3 — Plugin (the brain)

### Task 7: `plannen-day-plan` skill

**Files:**
- Create: `plugin/skills/plannen-day-plan.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: plannen-day-plan
description: Use when the user asks for today's plan, morning briefing, day plan, "what's on today", "what's my day looking like", or runs /plannen-today. Drives the Plannen MCP tools get_briefing_context → save_daily_briefing to compose a circle-aware structured day briefing. Also handles practice completion logging when the user mentions doing a practice.
---

# Plannen — day plan

Use when the user invokes `/plannen-today` or asks anything like "today's plan", "morning briefing", "day plan", "what's on today", "what's my day looking like". Compose a **structured, non-prose** briefing using the Plannen MCP tools, then persist it.

## Workflow

1. **Resolve date.** Default = today (in user's local timezone). If the user names a specific date ("tomorrow", "Friday", "2026-05-22"), resolve that date.

2. **Fetch context.** Call `get_briefing_context({ date })`. This returns events today + tomorrow, recent past events, your circle (family_members surfaced as "circle"), practices due today with weekly remaining counts, and locations. One call — no follow-up MCP reads unless the user asks a question requiring extra data.

3. **Compose the briefing.** Output markdown with this structure (omit any section that is empty):

   ```markdown
   # <Weekday>, <D Mon>

   ## Schedule
   - HH:MM — Event title (annotation if useful, e.g. "you driving")

   ## Practices today
   - [ ] Practice name (N/M this week)   // for weekly_count
   - [ ] Practice name (daily)            // for daily
   - [ ] Practice name                    // for specific_days

   ## Circle
   - One-line items about your circle relevant to the day:
     school holiday window, partner away dates, overdue calls, etc.
   ```

   **Format rules:**
   - **Bullets only**, no prose paragraphs, no motivational/coach copy.
   - Max ~30 lines total. If context overflows, prioritise: events with time conflicts > kids' events > partner's events > recurring reminders.
   - Practices: render `[ ]` when not yet done today, `[x]` if `completions_this_week` already includes today's date.
   - Times in 24h `HH:MM`.
   - Empty day: output a single line "Quiet day, no practices due." under `# <Weekday>, <D Mon>` and skip all sections.

4. **Persist.** Call `save_daily_briefing({ briefing_date, content_md, source })` with `source` matching the invocation surface:
   - `'claude_code'` when invoked from Claude Code
   - `'claude_desktop'` when invoked from Claude Desktop
   - `'web'` when invoked from a web client
   - `'cron'` when invoked by a scheduled job
   When in doubt, use `'claude_code'`.

5. **Handle completion mentions.** If, in the same turn or a follow-up, the user mentions doing a practice ("did gym", "took vitamins", "done with dishes"), call `mark_practice_done({ practice_id })` for each — resolve the practice by name from the context. Confirm with one short line: "Logged: gym, vitamins."

## Anti-patterns

- **Don't** call `list_events` separately — `get_briefing_context` already includes today's and tomorrow's events.
- **Don't** add motivational copy, encouragement, or coaching prose. The user wants a sketch, not a coach.
- **Don't** propose time slots for practices. Scheduling is out of scope for v1.
- **Don't** invent practices. Only render what `practices_due_today` returns.
- **Don't** auto-mark completions. Only when the user explicitly says they did something.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/skills/plannen-day-plan.md
git commit -m "feat(plugin): plannen-day-plan skill"
```

---

### Task 8: `plannen-today` slash command

**Files:**
- Create: `plugin/commands/plannen-today.md`

- [ ] **Step 1: Write the command**

```markdown
---
description: Compose today's circle-aware day plan (events + practices + family context) and persist it.
argument-hint: "[date — optional, e.g. 'tomorrow' or '2026-05-22']"
---

The user has invoked `/plannen-today` with arguments: `$ARGUMENTS`.

Trigger the `plannen-day-plan` skill and follow its workflow exactly. If `$ARGUMENTS` is empty or "today", resolve to today's date. If it names a relative date ("tomorrow", "Friday", "next Monday") or an ISO date, resolve to that date and pass it to `get_briefing_context`.

Do not ask for additional input — this command is meant for a one-shot morning briefing. Compose, save, and return the markdown.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/commands/plannen-today.md
git commit -m "feat(plugin): /plannen-today slash command"
```

---

## Phase 4 — Backend REST (Tier 0)

### Task 9: `practices` route module

**Files:**
- Create: `backend/src/routes/api/practices.ts`
- Test: `backend/src/routes/api/practices.test.ts`

Mirror the pattern from `backend/src/routes/api/locations.ts`.

- [ ] **Step 1: Write failing test** (against the test app)

```ts
// backend/src/routes/api/practices.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestApp, seedUser } from './_testFixtures.js'

describe('practices REST', () => {
  let app: ReturnType<typeof buildTestApp>['app']
  let token: string

  beforeEach(async () => {
    const t = buildTestApp()
    app = t.app
    token = (await seedUser(t.userId)).token
  })

  it('POST /api/practices creates a practice', async () => {
    const res = await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Gym',
        category: 'health',
        frequency_type: 'weekly_count',
        target_count: 3,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string; name: string } }
    expect(body.data.name).toBe('Gym')
  })

  it('GET /api/practices lists practices', async () => {
    await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Vitamin D', category: 'health', frequency_type: 'daily' }),
    })
    const res = await app.request('/api/practices', {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { data: Array<{ name: string }> }
    expect(body.data.map((p) => p.name)).toContain('Vitamin D')
  })

  it('POST /api/practices/:id/completions records a completion', async () => {
    const created = await app.request('/api/practices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Gym', category: 'health', frequency_type: 'daily' }),
    })
    const { data } = (await created.json()) as { data: { id: string } }

    const res = await app.request(`/api/practices/${data.id}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ completed_on: '2026-05-20' }),
    })
    expect(res.status).toBe(201)

    // idempotent
    const res2 = await app.request(`/api/practices/${data.id}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ completed_on: '2026-05-20' }),
    })
    expect(res2.status).toBe(201)
  })
})
```

- [ ] **Step 2: Write the routes module**

```ts
// backend/src/routes/api/practices.ts
import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const practices = new Hono<{ Variables: AppVariables }>()

const Category = z.enum(['health', 'household', 'circle', 'focus', 'other'])
const FrequencyType = z.enum(['daily', 'weekly_count', 'specific_days'])
const TimeOfDay = z.enum(['morning', 'afternoon', 'evening', 'anytime'])
const DayKey = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

const PracticeInput = z.object({
  name: z.string().min(1),
  category: Category,
  frequency_type: FrequencyType,
  target_count: z.number().int().min(1).max(7).nullable().optional(),
  days_of_week: z.array(DayKey).nullable().optional(),
  preferred_time_of_day: TimeOfDay.optional(),
  family_member_id: z.string().uuid().nullable().optional(),
})

const PracticePatch = PracticeInput.partial().extend({
  active: z.boolean().optional(),
})

const CompletionInput = z.object({
  completed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  family_member_id: z.string().uuid().nullable().optional(),
})

practices.get('/', async (c) => {
  const userId = c.var.userId
  const activeOnly = c.req.query('active_only') === 'true'
  return await withUserContext(userId, async (db) => {
    const where: string[] = ['user_id = $1']
    const params: unknown[] = [userId]
    if (activeOnly) where.push('active = true')
    const { rows } = await db.query(
      `SELECT * FROM plannen.practices WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
      params,
    )
    return c.json({ data: rows })
  })
})

practices.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = PracticeInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid practice', JSON.stringify(parsed.error.issues))
  const p = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.practices
         (user_id, family_member_id, name, category, frequency_type,
          target_count, days_of_week, preferred_time_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'anytime'))
       RETURNING *`,
      [userId, p.family_member_id ?? null, p.name, p.category, p.frequency_type,
       p.target_count ?? null, p.days_of_week ?? null, p.preferred_time_of_day ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

practices.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = PracticePatch.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid practice patch', JSON.stringify(parsed.error.issues))
  const sets: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(parsed.data)) {
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.practices SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    return c.json({ data: rows[0] })
  })
})

practices.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE plannen.practices SET active = false WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    return c.body(null, 204)
  })
})

practices.post('/:id/completions', async (c) => {
  const userId = c.var.userId
  const practiceId = c.req.param('id')
  const parsed = CompletionInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid completion', JSON.stringify(parsed.error.issues))
  const date = parsed.data.completed_on ?? new Date().toISOString().slice(0, 10)
  return await withUserContext(userId, async (db) => {
    const { rowCount: owns } = await db.query(
      `SELECT 1 FROM plannen.practices WHERE id = $1 AND user_id = $2`,
      [practiceId, userId],
    )
    if (owns === 0) throw new HttpError(404, 'NOT_FOUND', 'practice not found')
    // ON CONFLICT without a target — schema has two partial unique indexes
    // (one for non-null family_member_id, one for null). Postgres picks the
    // matching partial index for the inserted row.
    await db.query(
      `INSERT INTO plannen.practice_completions (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [practiceId, userId, parsed.data.family_member_id ?? null, date],
    )
    return c.json({ data: { practice_id: practiceId, completed_on: date } }, 201)
  })
})

practices.delete('/:id/completions/:date', async (c) => {
  const userId = c.var.userId
  const practiceId = c.req.param('id')
  const date = c.req.param('date')
  return await withUserContext(userId, async (db) => {
    await db.query(
      `DELETE FROM plannen.practice_completions
       WHERE practice_id = $1 AND user_id = $2 AND completed_on = $3::date`,
      [practiceId, userId, date],
    )
    return c.body(null, 204)
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/api/practices.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/api/practices.ts backend/src/routes/api/practices.test.ts
git commit -m "feat(backend): /api/practices CRUD + completions endpoints"
```

---

### Task 10: `briefings` route module

**Files:**
- Create: `backend/src/routes/api/briefings.ts`
- Test: `backend/src/routes/api/briefings.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/src/routes/api/briefings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestApp, seedUser } from './_testFixtures.js'

describe('briefings REST', () => {
  let app: ReturnType<typeof buildTestApp>['app']
  let token: string

  beforeEach(async () => {
    const t = buildTestApp()
    app = t.app
    token = (await seedUser(t.userId)).token
  })

  it('POST /api/briefings upserts a briefing', async () => {
    const res = await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        briefing_date: '2026-05-20',
        content_md: '# Tuesday\n\n## Schedule\n- 08:00 — Vitamin D',
        source: 'web',
      }),
    })
    expect(res.status).toBe(201)

    // Second save overwrites.
    const res2 = await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        briefing_date: '2026-05-20',
        content_md: '# Tuesday\n\n## Schedule\n- 09:00 — Standup',
        source: 'web',
      }),
    })
    expect(res2.status).toBe(201)
  })

  it('GET /api/briefings/:date returns latest', async () => {
    await app.request('/api/briefings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ briefing_date: '2026-05-20', content_md: 'hi', source: 'web' }),
    })
    const res = await app.request('/api/briefings/2026-05-20', {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { data: { content_md: string } | null }
    expect(body.data?.content_md).toBe('hi')
  })

  it('GET /api/briefings/:date returns null when missing', async () => {
    const res = await app.request('/api/briefings/2026-01-01', {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toBeNull()
  })
})
```

- [ ] **Step 2: Write the routes module**

```ts
// backend/src/routes/api/briefings.ts
import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const briefings = new Hono<{ Variables: AppVariables }>()

const BriefingInput = z.object({
  briefing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content_md: z.string().min(1),
  summary: z.string().nullable().optional(),
  source: z.enum(['claude_code', 'claude_desktop', 'web', 'cron']),
})

briefings.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = BriefingInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid briefing', JSON.stringify(parsed.error.issues))
  const b = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.daily_briefings
         (user_id, briefing_date, content_md, summary, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, briefing_date) DO UPDATE
         SET content_md = EXCLUDED.content_md,
             summary = EXCLUDED.summary,
             source = EXCLUDED.source,
             generated_at = now()
       RETURNING *`,
      [userId, b.briefing_date, b.content_md, b.summary ?? null, b.source],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

briefings.get('/:date', async (c) => {
  const userId = c.var.userId
  const date = c.req.param('date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'VALIDATION', 'date must be YYYY-MM-DD')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT id, briefing_date::text, content_md, summary, source, generated_at
       FROM plannen.daily_briefings
       WHERE user_id = $1 AND briefing_date = $2::date`,
      [userId, date],
    )
    return c.json({ data: rows[0] ?? null })
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/api/briefings.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/api/briefings.ts backend/src/routes/api/briefings.test.ts
git commit -m "feat(backend): /api/briefings GET + POST (upsert)"
```

---

### Task 11: Register routes in backend root

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Find current route registrations**

Run: `grep -n "route(\|.route(\"" backend/src/index.ts | head -20`

You will see lines like `.route('/api/locations', locations)`. Mirror that.

- [ ] **Step 2: Add imports + registrations**

Add to the imports block:
```ts
import { practices } from './routes/api/practices.js'
import { briefings } from './routes/api/briefings.js'
```

Add to the route registration block (next to `locations`):
```ts
  .route('/api/practices', practices)
  .route('/api/briefings', briefings)
```

- [ ] **Step 3: Run all backend tests**

Run: `cd backend && npx vitest run`
Expected: previously-passing tests still pass, plus the new practices + briefings tests.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): mount practices + briefings routes"
```

---

## Phase 5 — DbClient (web)

### Task 12: Extend DbClient types interface

**Files:**
- Modify: `src/lib/dbClient/types.ts`

- [ ] **Step 1: Add row types**

Append to the row-types section (after `FactRow`):

```ts
export type PracticeRow = Record<string, unknown> & {
  id: string
  user_id: string
  family_member_id: string | null
  name: string
  category: 'health' | 'household' | 'circle' | 'focus' | 'other'
  frequency_type: 'daily' | 'weekly_count' | 'specific_days'
  target_count: number | null
  days_of_week: string[] | null
  preferred_time_of_day: 'morning' | 'afternoon' | 'evening' | 'anytime'
  active: boolean
  created_at: string
  updated_at: string
}

export type PracticeCompletionRow = {
  practice_id: string
  completed_on: string
}

export type DailyBriefingRow = {
  id: string
  briefing_date: string
  content_md: string
  summary: string | null
  source: 'claude_code' | 'claude_desktop' | 'web' | 'cron'
  generated_at: string
}
```

- [ ] **Step 2: Add namespaces to the DbClient interface**

Insert before the closing `}`:

```ts
  practices: {
    list: (params?: { active_only?: boolean }) => Promise<PracticeRow[]>
    create: (input: Partial<PracticeRow> & { name: string; category: PracticeRow['category']; frequency_type: PracticeRow['frequency_type'] }) => Promise<PracticeRow>
    update: (id: string, patch: Partial<PracticeRow>) => Promise<PracticeRow>
    delete: (id: string) => Promise<void>
    markDone: (input: { practice_id: string; completed_on?: string; family_member_id?: string | null }) => Promise<void>
    unmarkDone: (input: { practice_id: string; completed_on: string; family_member_id?: string | null }) => Promise<void>
    completionsThisWeek: (date: string) => Promise<PracticeCompletionRow[]>
  }
  briefings: {
    getByDate: (date: string) => Promise<DailyBriefingRow | null>
    save: (input: { briefing_date: string; content_md: string; summary?: string | null; source: DailyBriefingRow['source'] }) => Promise<DailyBriefingRow>
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `tier0.ts` and `tier1.ts` complaining about missing implementations — exactly what's expected, since we'll implement them next.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dbClient/types.ts
git commit -m "feat(dbClient): practices + briefings interface"
```

---

### Task 13: Tier 0 dbClient implementation

**Files:**
- Modify: `src/lib/dbClient/tier0.ts`

- [ ] **Step 1: Add imports**

```ts
import type { DailyBriefingRow, PracticeRow, PracticeCompletionRow } from './types'
```

(Add to the existing import block of `types`.)

- [ ] **Step 2: Add the new namespaces** (insert in the same shape as `locations`):

```ts
  practices: {
    list: (params) => api<PracticeRow[]>(`/api/practices${qs({ active_only: params?.active_only })}`),
    create: (input) => api<PracticeRow>('/api/practices', { method: 'POST', body: JSON.stringify(input) }),
    update: (id, patch) =>
      api<PracticeRow>(`/api/practices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: async (id) => { await api(`/api/practices/${id}`, { method: 'DELETE' }) },
    markDone: async (input) => {
      await api(`/api/practices/${input.practice_id}/completions`, {
        method: 'POST',
        body: JSON.stringify({ completed_on: input.completed_on, family_member_id: input.family_member_id }),
      })
    },
    unmarkDone: async (input) => {
      await api(`/api/practices/${input.practice_id}/completions/${input.completed_on}`, { method: 'DELETE' })
    },
    completionsThisWeek: (date) => api<PracticeCompletionRow[]>(`/api/practices/completions?since=${date}`),
  },
  briefings: {
    getByDate: (date) => api<DailyBriefingRow | null>(`/api/briefings/${date}`),
    save: (input) => api<DailyBriefingRow>('/api/briefings', { method: 'POST', body: JSON.stringify(input) }),
  },
```

- [ ] **Step 3: Add the supporting backend endpoint for `completionsThisWeek`**

In `backend/src/routes/api/practices.ts`, add before the `:id` routes:

```ts
practices.get('/completions', async (c) => {
  const userId = c.var.userId
  const since = c.req.query('since')
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new HttpError(400, 'VALIDATION', 'since=YYYY-MM-DD required')
  }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT practice_id, completed_on::text
       FROM plannen.practice_completions
       WHERE user_id = $1 AND completed_on >= $2::date
       ORDER BY completed_on DESC`,
      [userId, since],
    )
    return c.json({ data: rows })
  })
})
```

- [ ] **Step 4: Add a test for the new endpoint**

Append to `backend/src/routes/api/practices.test.ts`:

```ts
it('GET /api/practices/completions returns completions since date', async () => {
  const created = await app.request('/api/practices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Gym', category: 'health', frequency_type: 'daily' }),
  })
  const { data } = (await created.json()) as { data: { id: string } }

  await app.request(`/api/practices/${data.id}/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ completed_on: '2026-05-18' }),
  })

  const res = await app.request('/api/practices/completions?since=2026-05-18', {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { data: Array<{ practice_id: string; completed_on: string }> }
  expect(body.data).toHaveLength(1)
  expect(body.data[0].completed_on).toBe('2026-05-18')
})
```

- [ ] **Step 5: Run tests + typecheck**

```bash
cd backend && npx vitest run src/routes/api/practices.test.ts
cd .. && npx tsc --noEmit
```
Expected: passing tests, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dbClient/tier0.ts backend/src/routes/api/practices.ts backend/src/routes/api/practices.test.ts
git commit -m "feat(dbClient/tier0): practices + briefings REST wiring"
```

---

### Task 14: Tier 1 dbClient implementation

**Files:**
- Modify: `src/lib/dbClient/tier1.ts`

- [ ] **Step 1: Add imports**

```ts
import type { DailyBriefingRow, PracticeRow, PracticeCompletionRow } from './types'
```

- [ ] **Step 2: Add the two namespaces** (mirror the `locations` block):

```ts
  practices: {
    list: async (params) => {
      const userId = await currentUserId()
      let q = supabase.from('practices').select('*').eq('user_id', userId).order('created_at', { ascending: true })
      if (params?.active_only) q = q.eq('active', true)
      return unwrap(await q) as PracticeRow[]
    },
    create: async (input) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('practices').insert({ ...input, user_id: userId }).select().single()) as PracticeRow
    },
    update: async (id, patch) => {
      return unwrap(await supabase.from('practices').update(patch).eq('id', id).select().single()) as PracticeRow
    },
    delete: async (id) => {
      const { error } = await supabase.from('practices').update({ active: false }).eq('id', id)
      if (error) throw new Error(error.message)
    },
    markDone: async (input) => {
      const userId = await currentUserId()
      const date = input.completed_on ?? new Date().toISOString().slice(0, 10)
      const { error } = await supabase.from('practice_completions').insert({
        practice_id: input.practice_id,
        user_id: userId,
        family_member_id: input.family_member_id ?? null,
        completed_on: date,
      })
      // Treat unique-violation as success (idempotent).
      if (error && error.code !== '23505') throw new Error(error.message)
    },
    unmarkDone: async (input) => {
      const userId = await currentUserId()
      let q = supabase.from('practice_completions').delete()
        .eq('practice_id', input.practice_id)
        .eq('user_id', userId)
        .eq('completed_on', input.completed_on)
      if (input.family_member_id == null) q = q.is('family_member_id', null)
      else q = q.eq('family_member_id', input.family_member_id)
      const { error } = await q
      if (error) throw new Error(error.message)
    },
    completionsThisWeek: async (date) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('practice_completions')
        .select('practice_id, completed_on')
        .eq('user_id', userId)
        .gte('completed_on', date)) as PracticeCompletionRow[]
    },
  },
  briefings: {
    getByDate: async (date) => {
      const userId = await currentUserId()
      const res = await supabase.from('daily_briefings')
        .select('*').eq('user_id', userId).eq('briefing_date', date).maybeSingle()
      return unwrapOrNull(res) as DailyBriefingRow | null
    },
    save: async (input) => {
      const userId = await currentUserId()
      return unwrap(await supabase.from('daily_briefings')
        .upsert({ ...input, user_id: userId }, { onConflict: 'user_id,briefing_date' })
        .select().single()) as DailyBriefingRow
    },
  },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dbClient/tier1.ts
git commit -m "feat(dbClient/tier1): practices + briefings via supabase-js"
```

---

### Task 15: Contract test additions

**Files:**
- Modify: `src/lib/dbClient/contract.test.ts`

- [ ] **Step 1: Read the existing file to understand the pattern**

Run: `head -80 src/lib/dbClient/contract.test.ts`

- [ ] **Step 2: Add a test asserting both impls have the new namespaces**

Append:

```ts
describe('practices + briefings contract', () => {
  for (const [name, impl] of [['tier0', tier0], ['tier1', tier1]] as const) {
    it(`${name}: has practices namespace with required methods`, () => {
      expect(impl.practices.list).toBeTypeOf('function')
      expect(impl.practices.create).toBeTypeOf('function')
      expect(impl.practices.update).toBeTypeOf('function')
      expect(impl.practices.delete).toBeTypeOf('function')
      expect(impl.practices.markDone).toBeTypeOf('function')
      expect(impl.practices.unmarkDone).toBeTypeOf('function')
      expect(impl.practices.completionsThisWeek).toBeTypeOf('function')
    })
    it(`${name}: has briefings namespace with required methods`, () => {
      expect(impl.briefings.getByDate).toBeTypeOf('function')
      expect(impl.briefings.save).toBeTypeOf('function')
    })
  }
})
```

- [ ] **Step 3: Run contract test**

Run: `npx vitest run src/lib/dbClient/contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dbClient/contract.test.ts
git commit -m "test(dbClient): contract assertions for practices + briefings"
```

---

## Phase 6 — Web UI

### Task 16: Service wrappers

**Files:**
- Create: `src/services/practiceService.ts`
- Create: `src/services/briefingService.ts`

Thin wrappers around `dbClient`. Match the existing `eventService.ts` style.

- [ ] **Step 1: Write `practiceService.ts`**

```ts
import { dbClient } from '../lib/dbClient'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'

export async function listPractices(activeOnly = true): Promise<PracticeRow[]> {
  return dbClient.practices.list({ active_only: activeOnly })
}

export async function createPractice(input: Partial<PracticeRow> & {
  name: string
  category: PracticeRow['category']
  frequency_type: PracticeRow['frequency_type']
}): Promise<PracticeRow> {
  return dbClient.practices.create(input)
}

export async function updatePractice(id: string, patch: Partial<PracticeRow>): Promise<PracticeRow> {
  return dbClient.practices.update(id, patch)
}

export async function deletePractice(id: string): Promise<void> {
  await dbClient.practices.delete(id)
}

export async function markPracticeDone(practiceId: string, completedOn?: string): Promise<void> {
  await dbClient.practices.markDone({ practice_id: practiceId, completed_on: completedOn })
}

export async function unmarkPracticeDone(practiceId: string, completedOn: string): Promise<void> {
  await dbClient.practices.unmarkDone({ practice_id: practiceId, completed_on: completedOn })
}

export async function completionsThisWeek(date: string): Promise<PracticeCompletionRow[]> {
  return dbClient.practices.completionsThisWeek(date)
}
```

- [ ] **Step 2: Write `briefingService.ts`**

```ts
import { dbClient } from '../lib/dbClient'
import type { DailyBriefingRow } from '../lib/dbClient/types'

export async function getTodayBriefing(date: string): Promise<DailyBriefingRow | null> {
  return dbClient.briefings.getByDate(date)
}

export async function saveBriefing(input: {
  briefing_date: string
  content_md: string
  summary?: string | null
  source: DailyBriefingRow['source']
}): Promise<DailyBriefingRow> {
  return dbClient.briefings.save(input)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/practiceService.ts src/services/briefingService.ts
git commit -m "feat(web): practice + briefing service wrappers"
```

---

### Task 17: `Today` component

**Files:**
- Create: `src/components/Today.tsx`

- [ ] **Step 1: Add a markdown renderer dep check**

Run: `grep -E 'react-markdown|markdown-it' package.json`

If `react-markdown` is already present, use it. If not, you can render content as a `<pre>` block for v1 — the briefing is already structured markdown with bullets, so monospace looks fine.

- [ ] **Step 2: Write the component (markdown-as-pre fallback shown)**

```tsx
import { useEffect, useState, useCallback } from 'react'
import type { DailyBriefingRow, PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import {
  listPractices,
  markPracticeDone,
  unmarkPracticeDone,
  completionsThisWeek,
} from '../services/practiceService'
import { getTodayBriefing } from '../services/briefingService'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const js = d.getUTCDay() || 7 // Sun = 7
  d.setUTCDate(d.getUTCDate() - (js - 1))
  return d.toISOString().slice(0, 10)
}

export function Today() {
  const [date] = useState(todayIso())
  const [briefing, setBriefing] = useState<DailyBriefingRow | null>(null)
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [b, p, c] = await Promise.all([
      getTodayBriefing(date),
      listPractices(true),
      completionsThisWeek(weekStart(date)),
    ])
    setBriefing(b)
    setPractices(p)
    setCompletions(c)
    setLoading(false)
  }, [date])

  useEffect(() => { void refresh() }, [refresh])

  const isDoneToday = (practiceId: string) =>
    completions.some((c) => c.practice_id === practiceId && c.completed_on === date)

  const toggle = async (p: PracticeRow) => {
    if (isDoneToday(p.id)) {
      await unmarkPracticeDone(p.id, date)
    } else {
      await markPracticeDone(p.id, date)
    }
    await refresh()
  }

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm text-gray-500">{date}</p>
      </header>

      <section>
        <h2 className="text-lg font-medium mb-2">Briefing</h2>
        {briefing ? (
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-50 rounded p-4 border border-gray-200">
            {briefing.content_md}
          </pre>
        ) : (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
            No briefing for today yet. Ask Claude: <code>/plannen-today</code>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Practices</h2>
        {practices.length === 0 ? (
          <p className="text-sm text-gray-500">
            No practices defined. Ask Claude to add one (e.g. "add gym 3×/week").
          </p>
        ) : (
          <ul className="space-y-2">
            {practices.map((p) => {
              const done = isDoneToday(p.id)
              const weekDone = completions.filter((c) => c.practice_id === p.id).length
              const label = p.frequency_type === 'weekly_count'
                ? `${p.name} (${weekDone}/${p.target_count ?? 0} this week)`
                : p.frequency_type === 'daily' ? `${p.name} (daily)` : p.name
              return (
                <li key={p.id}>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={done} onChange={() => void toggle(p)}
                           className="h-4 w-4" />
                    <span className={done ? 'line-through text-gray-400' : ''}>{label}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Today.tsx
git commit -m "feat(web): Today component — briefing viewer + practice checkboxes"
```

---

### Task 18: Wire Today into Dashboard as default

**Files:**
- Modify: `src/pages/Dashboard.tsx`

- [ ] **Step 1: Edit the `View` type**

Change line 19:
```ts
type View = 'today' | 'feed' | 'family' | 'friends' | 'groups' | 'stories' | 'settings'
```

- [ ] **Step 2: Edit `parseView` to default to `'today'`**

Replace the body of `parseView`:
```ts
function parseView(v: string | null): View {
  if (v === 'today' || v === 'feed' || v === 'family' || v === 'friends' ||
      v === 'groups' || v === 'stories' || v === 'settings') {
    return v
  }
  return 'today'
}
```

- [ ] **Step 3: Update the empty-param shortcut**

In `handleViewChange`, change the special-case from `'feed'` to `'today'`:
```ts
const handleViewChange = (view: View) => {
  if (view === 'today') {
    setSearchParams({}, { replace: true })
  } else {
    setSearchParams({ view }, { replace: true })
  }
}
```

- [ ] **Step 4: Add Today import and render case**

Add to imports:
```ts
import { Today } from '../components/Today'
```

Add to the render block (just before `{currentView === 'feed' && <MyFeed />}`):
```tsx
{currentView === 'today' && <Today />}
```

- [ ] **Step 5: Smoke check**

Run: `npm run dev` (port 4321 per project rule).
Open `http://localhost:4321/` in a browser. You should land on the new Today view (no `?view=` param), with the "No briefing for today yet" empty state and any practices listed underneath.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(web): /today is the default landing view"
```

---

### Task 19: Add Today tab to Navigation

**Files:**
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: Read Navigation.tsx to find the tab list**

Run: `grep -n "feed\|family\|friends" src/components/Navigation.tsx | head`

There will be an array or list of tab definitions (label + view key).

- [ ] **Step 2: Add a `'today'` entry as the first tab**

Insert a new entry at the start of the tab array, mirroring the shape of the existing entries. Label: `"Today"`. View key: `'today'`. Icon: pick from `lucide-react` — `Sun` or `Sunrise`.

Example shape (adapt to whatever the file uses):
```tsx
{ key: 'today', label: 'Today', icon: Sun },
{ key: 'feed', label: 'Feed', icon: Newspaper },
// ...existing
```

Add the import: `import { Sun } from 'lucide-react'` (or merge with the existing import line).

- [ ] **Step 3: Verify in browser**

Refresh `http://localhost:4321/?view=feed`. Click the new "Today" tab. URL should become `/` (no query). Page should render the Today component.

- [ ] **Step 4: Commit**

```bash
git add src/components/Navigation.tsx
git commit -m "feat(web): Today tab in main navigation"
```

---

## Phase 7 — End-to-end + Smoke

### Task 20: Behavioral smoke + plugin manifest update

**Files:**
- Modify: `plugin/.claude-plugin/plugin.json` (or wherever the plugin registers commands/skills — check existing structure)

- [ ] **Step 1: Confirm plugin manifest layout**

Run: `find plugin -maxdepth 3 -name "plugin.json" -o -name "manifest.json" 2>/dev/null | head -5`

If the plugin auto-discovers `skills/*.md` and `commands/*.md`, there is nothing more to register. If there is a manifest, add `plannen-day-plan` (skill) and `plannen-today` (command).

- [ ] **Step 2: Restart the MCP server**

Run: `npx plannen down && npx plannen up`
Expected: backend on 54323, embedded postgres on 54322, web dev on 4321. No errors in the MCP startup logs.

- [ ] **Step 3: End-to-end smoke (manual)**

In your Claude client (Code or Desktop) that has the plannen MCP server configured:

1. Run: `create_practice({ name: 'Gym', category: 'health', frequency_type: 'weekly_count', target_count: 3 })`.
   Expected: a row returned with an `id`.
2. Run: `/plannen-today`.
   Expected: Claude composes a structured briefing referencing the gym practice with "(0/3 this week)" — and a `save_daily_briefing` call appears in the trace.
3. Open `http://localhost:4321/`.
   Expected: lands on `/today`, shows the briefing markdown, shows the gym checkbox.
4. Tick the gym checkbox.
   Expected: the checkbox stays checked after a refresh. Refresh confirms `practice_completions` got a row.

- [ ] **Step 4: Final commit + push**

If the plugin manifest needed updating:
```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "feat(plugin): register plannen-day-plan skill + /plannen-today command"
```

Push:
```bash
git push origin feat/daily_routine_agent
```

---

## Self-review checklist

- [x] **Spec coverage:**
  - Practices schema + RLS → Task 1 ✓
  - Helper logic (frequency-due, week-boundary) → Task 2 ✓
  - MCP tools (list/create/update/delete/mark_done/unmark_done/get_context/save_briefing/get_briefing) → Tasks 3–6 ✓
  - Plugin skill + slash command → Tasks 7–8 ✓
  - Backend REST + dbClient (tier0 + tier1) → Tasks 9–15 ✓
  - Web `/today` route + Today component + Navigation → Tasks 16–19 ✓
  - End-to-end smoke → Task 20 ✓
- [x] **No placeholders** — every task has full SQL / TypeScript / markdown bodies.
- [x] **Type consistency** — `mark_practice_done` everywhere (no straggler `mark_practice_complete`); `practice_id` everywhere; `practices_due_today` shape consistent.
- [x] **Family-aware terminology** — `circle` in product copy; `family_members` table kept as decided in Slice H deferral.

## Out-of-scope reminders (do NOT add to this plan)

- Goals model (marathon, 1000km cycling) — Slice E.
- LLM scheduling — Slice D.
- Push channels (email/print/WhatsApp/PDF) — Slice B.
- Cron-scheduled generation — Slice C.
- Streak / insights UI — Slice F.
- Web habit-definition form — Slice G.
- `family_members` table rename — Slice H.
