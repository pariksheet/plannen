# To-do Event Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `event_kind='todo'` — a dated, checkable, one-off task — that renders with a checkbox across the Timeline, Calendar, and Schedule views and is created/completed via both MCP servers.

**Architecture:** A todo is an `events` row with two new columns (`completed_at`, `assigned_to`); no new table. Completion is a single `completed_at` timestamp (NULL = open). Overdue is derived (`!completed_at && start_date < now`), never stored. `event_status` is left untouched for todos — the auto-resolver skips them. The `EventCard` component is reused with a checkbox; `assigned_to` always defaults to the creator in phase 1.

**Tech Stack:** Postgres (forward-only SQL migration), TypeScript, React + Vite + Tailwind, Vitest + Testing Library, Hono (Tier 0 backend REST), two MCP servers (Node stdio `mcp/src/index.ts` + Deno edge `supabase/functions/mcp/`).

**Spec:** `docs/superpowers/specs/2026-06-09-todo-event-type-design.md`

**Branch:** `feat/todo-event-type` (already created; spec already committed there).

---

## Conventions for the implementer

- Run frontend/shared unit tests with: `npx vitest run <path>`
- Run backend tests with: `cd backend && npx vitest run <path>` (backend has its own vitest project)
- Type-check the web app with: `npx tsc -p tsconfig.json --noEmit`
- MCP parity gate: `node scripts/check-mcp-parity.mjs`
- **Hard rule (CLAUDE.md):** every MCP tool must exist in BOTH `mcp/src/index.ts` AND `supabase/functions/mcp/tools/events.ts`. Tasks 6 and 7 are a matched pair — do not commit one without the other or CI parity fails.
- **Hard rule (CLAUDE.md):** this repo is PUBLIC. Use only invented personas/generic data in tests ("Milo", "Renew passport", "example.org").
- Commit after each task (messages provided). Branch is already `feat/todo-event-type`.

---

## Task 1: Database migration — new columns + extended `event_kind`

**Files:**
- Create: `supabase/migrations/20260609120000_todo_event_type.sql`

- [ ] **Step 1: Write the migration**

```sql
-- To-do event type: a dated, checkable, one-off task.
-- Adds `todo` to the event_kind enum, plus completion + assignment columns.
-- Forward-only; no data backfill needed (no todos exist yet).

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_event_kind_check";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_event_kind_check"
  CHECK (("event_kind" = ANY (ARRAY['event'::"text", 'reminder'::"text", 'session'::"text", 'todo'::"text"])));

ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "assigned_to" "uuid";

COMMENT ON COLUMN "plannen"."events"."event_kind" IS 'event = full event (URL, RSVP, watch); reminder = simple appointment/reminder; todo = checkable one-off task (completed_at tracks done-state); session = generated child of a recurring event';
COMMENT ON COLUMN "plannen"."events"."completed_at" IS 'For event_kind=todo: timestamp the task was checked off; NULL = open. Unused for other kinds.';
COMMENT ON COLUMN "plannen"."events"."assigned_to" IS 'For event_kind=todo: user the task is assigned to. Phase 1 always equals created_by; no FK so it can later point at a user or family member.';
```

- [ ] **Step 2: Apply the migration**

Run: `npx plannen migrate`
Expected: completes without error; output lists `20260609120000_todo_event_type` as applied.

- [ ] **Step 3: Verify the schema changed**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "\d+ plannen.events" | grep -E "completed_at|assigned_to|event_kind_check"
```
Expected: `completed_at` and `assigned_to` columns appear, and the check constraint text includes `todo`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260609120000_todo_event_type.sql
git commit -m "feat(todo): migration — completed_at, assigned_to, todo event_kind"
```

---

## Task 2: Types + status resolver guard + overdue helper

**Files:**
- Modify: `src/types/event.ts`
- Test: `src/types/event.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create or append to `src/types/event.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveEventStatus, isTodoOverdue, Event } from './event'

const baseTodo: Event = {
  id: 't1', title: 'Renew passport', description: null,
  start_date: '2020-01-01T09:00:00.000Z', end_date: null,
  enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
  image_url: null, location: null, hashtags: null,
  event_kind: 'todo', event_type: 'personal', event_status: 'going',
  created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
  completed_at: null, assigned_to: 'u1',
}

describe('todo status + overdue', () => {
  it('resolveEventStatus never auto-flips a past todo to past/missed', () => {
    const resolved = resolveEventStatus(baseTodo)
    expect(resolved.event_status).toBe('going')
  })

  it('isTodoOverdue is true for an open todo whose start_date has passed', () => {
    expect(isTodoOverdue(baseTodo, new Date('2026-06-09T00:00:00Z'))).toBe(true)
  })

  it('isTodoOverdue is false once completed', () => {
    expect(isTodoOverdue({ ...baseTodo, completed_at: '2026-06-08T00:00:00Z' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })

  it('isTodoOverdue is false for a future todo', () => {
    expect(isTodoOverdue({ ...baseTodo, start_date: '2999-01-01T00:00:00Z' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })

  it('isTodoOverdue is false for non-todo kinds', () => {
    expect(isTodoOverdue({ ...baseTodo, event_kind: 'reminder' }, new Date('2026-06-09T00:00:00Z'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types/event.test.ts`
Expected: FAIL — `isTodoOverdue` is not exported; `completed_at`/`assigned_to` are type errors on `Event`.

- [ ] **Step 3: Implement the type + helper changes**

In `src/types/event.ts`:

Change line 3:
```ts
export type EventKind = 'event' | 'reminder' | 'session' | 'todo'
```

Add to the `Event` interface (after `parent_event_id?` on line 28):
```ts
  completed_at?: string | null
  assigned_to?: string | null
```

Add a guard as the FIRST line inside `resolveEventStatus` (before `const raw = event.event_status` on line 57):
```ts
  // Completion for todos is tracked via completed_at, never event_status — so
  // a past, unfinished todo must stay visible, not silently become past/missed.
  if (event.event_kind === 'todo') return event
```

Add this exported helper at the end of the file:
```ts
export function isTodoOverdue(event: Event, now: Date = new Date()): boolean {
  return event.event_kind === 'todo' && !event.completed_at && new Date(event.start_date) < now
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/types/event.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types/event.ts src/types/event.test.ts
git commit -m "feat(todo): EventKind 'todo', completed_at/assigned_to types, isTodoOverdue + resolver guard"
```

---

## Task 3: Tier 0 backend REST — accept the new columns

The Tier 0 web app writes through `/api/events`. The POST has an explicit INSERT column list and a Zod schema; the PATCH uses an `ALLOWED_UPDATE_COLUMNS` whitelist. Both must learn the new columns.

**Files:**
- Modify: `backend/src/routes/api/events.ts`
- Test: `backend/src/routes/api/events.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/routes/api/events.test.ts` (match the existing test harness in that file for app construction / auth — reuse its existing `makeRequest`/client helper; the assertions below are the new behavior):

```ts
describe('todo columns', () => {
  it('POST persists event_kind=todo with assigned_to and completed_at null', async () => {
    const res = await postEvent({
      title: 'Renew passport',
      start_date: '2026-06-20T09:00:00.000Z',
      event_kind: 'todo',
      assigned_to: TEST_USER_ID,
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.event_kind).toBe('todo')
    expect(body.data.assigned_to).toBe(TEST_USER_ID)
    expect(body.data.completed_at).toBeNull()
  })

  it('PATCH sets completed_at', async () => {
    const created = await (await postEvent({
      title: 'Pay invoice', start_date: '2026-06-20T09:00:00.000Z', event_kind: 'todo',
    })).json()
    const res = await patchEvent(created.data.id, { completed_at: '2026-06-09T12:00:00.000Z' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.completed_at).toBe('2026-06-09T12:00:00.000Z')
  })
})
```

> Implementer note: `postEvent`, `patchEvent`, and `TEST_USER_ID` mirror whatever helpers/fixtures already exist at the top of `events.test.ts`. If the file uses inline `app.request(...)` calls, write these the same way rather than introducing new helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/api/events.test.ts`
Expected: FAIL — `assigned_to`/`completed_at` come back `undefined` (not inserted; PATCH column not whitelisted).

- [ ] **Step 3: Implement the backend changes**

In `backend/src/routes/api/events.ts`:

Add to the `CreateEvent` Zod object (after `parent_event_id` on line 29, before the closing `}).passthrough()`):
```ts
  assigned_to: z.string().uuid().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
```

Add to `ALLOWED_UPDATE_COLUMNS` (after `'gcal_event_id',` on line 47):
```ts
  'completed_at',
  'assigned_to',
```

Update the POST INSERT (lines 83-110). Change the column list, the VALUES list, and the params array to include the two new columns:

Column list — add `completed_at, assigned_to` before `created_by`:
```sql
       INSERT INTO plannen.events
         (title, description, start_date, end_date, enrollment_url, enrollment_deadline,
          enrollment_start_date, image_url, location, event_kind, event_type, event_status,
          shared_with_friends, hashtags, parent_event_id, completed_at, assigned_to, created_by)
```

VALUES — `$15, $16` becomes `$15` (parent), `$16` (completed_at), `$17` (assigned_to), `$18` (created_by):
```sql
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               COALESCE($10,'event'), COALESCE($11,'personal'), COALESCE($12,'going'),
               COALESCE($13,'none'), COALESCE($14,'{}'::text[]),
               $15, $16, $17, $18)
```

params array — insert two entries before `userId`:
```ts
        e.parent_event_id ?? null,
        e.completed_at ?? null,
        e.assigned_to ?? null,
        userId,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/api/events.test.ts`
Expected: PASS (new tests green; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api/events.ts backend/src/routes/api/events.test.ts
git commit -m "feat(todo): backend REST accepts completed_at/assigned_to on create + patch"
```

---

## Task 4: `eventService` — default assignment, complete/uncomplete, convert

**Files:**
- Modify: `src/services/eventService.ts`
- Test: `src/services/eventService.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create `src/services/eventService.test.ts` (mock `dbClient` the same way other service tests in this repo do — check an existing `src/services/*.test.ts` for the mock shape; the intent below is what matters):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: 'e1', ...patch }))
vi.mock('../lib/dbClient', () => ({
  dbClient: {
    me: { get: async () => ({ userId: 'u1' }) },
    events: { update },
  },
}))

import { completeTodo, uncompleteTodo, convertEventKind } from './eventService'

beforeEach(() => update.mockClear())

describe('todo service ops', () => {
  it('completeTodo sets a completed_at timestamp', async () => {
    await completeTodo('e1')
    expect(update).toHaveBeenCalledWith('e1', expect.objectContaining({ completed_at: expect.any(String) }))
  })

  it('uncompleteTodo clears completed_at', async () => {
    await uncompleteTodo('e1')
    expect(update).toHaveBeenCalledWith('e1', { completed_at: null })
  })

  it('convertEventKind to reminder clears completed_at', async () => {
    await convertEventKind('e1', 'reminder')
    expect(update).toHaveBeenCalledWith('e1', { event_kind: 'reminder', completed_at: null })
  })

  it('convertEventKind to todo leaves completion untouched', async () => {
    await convertEventKind('e1', 'todo')
    expect(update).toHaveBeenCalledWith('e1', { event_kind: 'todo' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/eventService.test.ts`
Expected: FAIL — `completeTodo`/`uncompleteTodo`/`convertEventKind` are not exported.

- [ ] **Step 3: Implement the service functions**

In `src/services/eventService.ts`:

In `createEvent`, set the default assignment. In the `dbClient.events.create({...})` call (lines 79-95), add after `created_by: userId,`:
```ts
      assigned_to: data.event_kind === 'todo' ? userId : null,
```
And make the status sensible for todos — extend the status block (lines 63-75) by adding a branch at the top of the `if (!eventStatus) {` body:
```ts
    if (data.event_kind === 'todo') {
      eventStatus = 'going' // completion is tracked via completed_at, not status
    } else if (data.event_kind === 'reminder') {
```
(i.e. prepend the `todo` branch and turn the existing `if (data.event_kind === 'reminder')` into an `else if`).

Add these exported functions at the end of the file (use the raw `dbClient.events.update` so the typed `EventFormData` whitelist in `updateEvent` doesn't strip the new fields):
```ts
import { dbClient } from '../lib/dbClient' // already imported at top — do not duplicate

export async function completeTodo(id: string): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const data = await dbClient.events.update(id, { completed_at: new Date().toISOString() }) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Complete failed') }
  }
}

export async function uncompleteTodo(id: string): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const data = await dbClient.events.update(id, { completed_at: null }) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Uncomplete failed') }
  }
}

export async function convertEventKind(id: string, kind: 'reminder' | 'todo'): Promise<{ data: Event | null; error: Error | null }> {
  const patch: Record<string, unknown> = { event_kind: kind }
  if (kind === 'reminder') patch.completed_at = null
  try {
    const data = await dbClient.events.update(id, patch) as unknown as Event
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Convert failed') }
  }
}
```
> Note: `dbClient` is already imported on line 1 — reuse it, do not add a second import. The comment in the snippet is a reminder, not a line to paste.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/eventService.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/eventService.ts src/services/eventService.test.ts
git commit -m "feat(todo): eventService completeTodo/uncompleteTodo/convertEventKind + creator default"
```

---

## Task 5: MCP local stdio server — schema, slim columns, complete/uncomplete tools

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Extend the slim projection so the new columns are returned**

`SLIM_EVENT_COLUMNS` (line 81-82) — append `, completed_at, assigned_to`:
```ts
const SLIM_EVENT_COLUMNS =
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id, completed_at, assigned_to'
```

`slimEvent` (lines 84-99) — add two fields to the returned object (after `enrollment_deadline:`):
```ts
    completed_at: e.completed_at ?? null,
    assigned_to: e.assigned_to ?? null,
```

- [ ] **Step 2: Allow `todo` on create and set the creator default**

In `createEvent` (line 217+):

Extend the args type (line 223 region) by adding:
```ts
  assigned_to?: string
```

Change the `event_kind` value expression (line 254) from:
```ts
        args.event_kind === 'reminder' ? 'reminder' : 'event',
```
to:
```ts
        args.event_kind === 'reminder' || args.event_kind === 'todo' ? args.event_kind : 'event',
```

Add `assigned_to` to the main INSERT (lines 242-261). Add the column to the column list (after `created_by,`):
```sql
       (title, description, start_date, end_date, location, event_kind,
        enrollment_url, hashtags, event_type, event_status, created_by,
        assigned_to, shared_with_friends, recurrence_rule)
```
Add a placeholder — the VALUES line becomes:
```sql
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, 'none', $12)
```
And insert the param after `id,` (the `created_by` value):
```ts
        id,
        args.event_kind === 'todo' ? (args.assigned_to ?? id) : null,
        args.recurrence_rule ?? null,
```
(The `recurrence_rule` param moves from `$11` to `$12` — already handled by the VALUES change above.)

- [ ] **Step 3: Add the complete/uncomplete handlers**

Add near the other event handlers (e.g. after `updateEvent`):
```ts
async function completeTodo(args: { id: string; completed_at?: string }) {
  const uId = await uid()
  const ts = args.completed_at ?? new Date().toISOString()
  return await withUserContext(uId, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.events SET completed_at = $1, updated_at = now()
       WHERE id = $2 AND created_by = $3 AND event_kind = 'todo'
       RETURNING *`,
      [ts, args.id, uId],
    )
    if (rows.length === 0) throw new Error('todo not found')
    return slimEvent(rows[0] as Record<string, unknown>)
  })
}

async function uncompleteTodo(args: { id: string }) {
  const uId = await uid()
  return await withUserContext(uId, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.events SET completed_at = NULL, updated_at = now()
       WHERE id = $1 AND created_by = $2 AND event_kind = 'todo'
       RETURNING *`,
      [args.id, uId],
    )
    if (rows.length === 0) throw new Error('todo not found')
    return slimEvent(rows[0] as Record<string, unknown>)
  })
}
```

- [ ] **Step 4: Update the `create_event` tool schema + add the two new tool defs**

In the `create_event` tool definition (line 1969+), change the `event_kind` enum (line 1979):
```ts
        event_kind: { type: 'string', enum: ['event', 'reminder', 'todo'] },
```
Add an `assigned_to` property (after `event_kind`):
```ts
        assigned_to: { type: 'string', description: 'User UUID to assign a todo to (defaults to creator). Only meaningful for event_kind=todo.' },
```

Add two new tool definitions in the tools array (e.g. right after the `update_event` definition that ends near line 2018):
```ts
  {
    name: 'complete_todo',
    description: 'Mark a todo (event_kind=todo) as done. Sets completed_at.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Todo (event) UUID' },
        completed_at: { type: 'string', description: 'ISO 8601 completion time (default: now)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'uncomplete_todo',
    description: 'Re-open a completed todo. Clears completed_at.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Todo (event) UUID' } },
      required: ['id'],
    },
  },
```

- [ ] **Step 5: Add dispatch cases**

In the CallTool switch (after line 2656 `case 'update_event'`):
```ts
      case 'complete_todo':      result = await completeTodo(args as Parameters<typeof completeTodo>[0]); break
      case 'uncomplete_todo':    result = await uncompleteTodo(args as Parameters<typeof uncompleteTodo>[0]); break
```

- [ ] **Step 6: Type-check the MCP package**

Run: `cd mcp && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(todo): local MCP — todo on create_event, complete_todo/uncomplete_todo, slim cols"
```

---

## Task 6: MCP edge server — schema, slim columns, complete/uncomplete tools (parity)

**Files:**
- Modify: `supabase/functions/mcp/tools/_shared.ts`
- Modify: `supabase/functions/mcp/tools/events.ts`

- [ ] **Step 1: Extend the shared slim projection**

In `supabase/functions/mcp/tools/_shared.ts`:

`SLIM_EVENT_COLUMNS` (line 98-99) — append `, completed_at, assigned_to`:
```ts
export const SLIM_EVENT_COLUMNS =
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id, completed_at, assigned_to'
```

`slimEvent` (line 101+) — add after `enrollment_deadline:`:
```ts
    completed_at: e.completed_at ?? null,
    assigned_to: e.assigned_to ?? null,
```

- [ ] **Step 2: Allow `todo` on create + creator default**

In `supabase/functions/mcp/tools/events.ts`, in the `createEvent` handler (line 224+):

Add to the args type (line ~230 region): `assigned_to?: string`.

Change the `event_kind` value (line 262) from:
```ts
      a.event_kind === 'reminder' ? 'reminder' : 'event',
```
to:
```ts
      a.event_kind === 'reminder' || a.event_kind === 'todo' ? a.event_kind : 'event',
```

Add `assigned_to` to the main INSERT (lines 251-261 region). Column list — add after `created_by,`:
```sql
       (title, description, start_date, end_date, location, event_kind,
        enrollment_url, hashtags, event_type, event_status, created_by,
        assigned_to, shared_with_friends, recurrence_rule)
```
VALUES line:
```sql
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, 'none', $12)
```
Params — after `ctx.userId,`:
```ts
      ctx.userId,
      a.event_kind === 'todo' ? (a.assigned_to ?? ctx.userId) : null,
      a.recurrence_rule ?? null,
```

- [ ] **Step 3: Update the `create_event` definition + add two tool defs**

In `definitions` (line 66+), change `event_kind` enum (line 76):
```ts
        event_kind: { type: 'string', enum: ['event', 'reminder', 'todo'] },
```
Add after it:
```ts
        assigned_to: { type: 'string', description: 'User UUID to assign a todo to (defaults to creator). Only meaningful for event_kind=todo.' },
```

Add two new definition objects to the `definitions` array (after the `update_event` def, before `rsvp_event`):
```ts
  {
    name: 'complete_todo',
    description: 'Mark a todo (event_kind=todo) as done. Sets completed_at.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Todo (event) UUID' },
        completed_at: { type: 'string', description: 'ISO 8601 completion time (default: now)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'uncomplete_todo',
    description: 'Re-open a completed todo. Clears completed_at.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Todo (event) UUID' } },
      required: ['id'],
    },
  },
```

- [ ] **Step 4: Add the two handlers + register them in the module**

Add handlers near `rsvpEvent`:
```ts
const completeTodo: ToolHandler = async (args, ctx) => {
  const a = args as { id: string; completed_at?: string }
  const ts = a.completed_at ?? new Date().toISOString()
  const { rows } = await ctx.client.query(
    `UPDATE plannen.events SET completed_at = $1, updated_at = now()
     WHERE id = $2 AND created_by = $3 AND event_kind = 'todo'
     RETURNING *`,
    [ts, a.id, ctx.userId],
  )
  if (rows.length === 0) throw new Error('todo not found')
  return slimEvent(rows[0] as Record<string, unknown>)
}

const uncompleteTodo: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const { rows } = await ctx.client.query(
    `UPDATE plannen.events SET completed_at = NULL, updated_at = now()
     WHERE id = $1 AND created_by = $2 AND event_kind = 'todo'
     RETURNING *`,
    [a.id, ctx.userId],
  )
  if (rows.length === 0) throw new Error('todo not found')
  return slimEvent(rows[0] as Record<string, unknown>)
}
```

In the `eventsModule.dispatch` object (line 359+), add:
```ts
    complete_todo: completeTodo,
    uncomplete_todo: uncompleteTodo,
```

(No change needed in `supabase/functions/mcp/index.ts` — `eventsModule` is already in `TOOLS`.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/_shared.ts supabase/functions/mcp/tools/events.ts
git commit -m "feat(todo): edge MCP — todo on create_event, complete_todo/uncomplete_todo, slim cols"
```

---

## Task 7: MCP parity gate

**Files:** none (verification task).

- [ ] **Step 1: Run the parity checker**

Run: `node scripts/check-mcp-parity.mjs`
Expected: `✓ MCP tool parity holds` and exit 0. (It scans for `name: '...'` declarations in both servers; `complete_todo` and `uncomplete_todo` must now appear on both sides.)

- [ ] **Step 2: If it fails**

If `complete_todo`/`uncomplete_todo` show under "missing from CLOUD" or "missing from LOCAL", you missed a `name:` declaration on that side — re-check Tasks 5 (local) and 6 (edge). Do not allowlist these in `LOCAL_ONLY` — they run fine in both.

- [ ] **Step 3: Commit (only if the script itself needed a tweak; normally nothing to commit)**

Skip if clean.

---

## Task 8: `EventCard` — checkbox, completed strikethrough, overdue tag, lean layout, convert kebab

The card already special-cases reminders via `isReminder`. Todos share the "lean" treatment (no RSVP / enrollment / memories) and add a checkbox + overdue tag.

**Files:**
- Modify: `src/components/EventCard.tsx`
- Test: `src/components/EventCard.todo.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/EventCard.todo.test.tsx` (model the render/setup on the existing `EventCard` usage in `ScheduleOverview.test.tsx`; supply required props with no-op handlers):

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventCard } from './EventCard'
import { Event } from '../types/event'

const todo: Event = {
  id: 't1', title: 'Renew passport', description: null,
  start_date: '2020-01-01T09:00:00.000Z', end_date: null,
  enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
  image_url: null, location: null, hashtags: null,
  event_kind: 'todo', event_type: 'personal', event_status: 'going',
  created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
  completed_at: null, assigned_to: 'u1',
}

const noop = () => {}

describe('EventCard todo', () => {
  it('renders a checkbox for a todo', () => {
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('shows an overdue tag for a past, open todo', () => {
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect(screen.getByText(/overdue/i)).toBeInTheDocument()
  })

  it('checked + strikethrough when completed', () => {
    render(<EventCard event={{ ...todo, completed_at: '2026-06-08T00:00:00Z' }} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Renew passport').className).toMatch(/line-through/)
    expect(screen.queryByText(/overdue/i)).toBeNull()
  })

  it('calls onToggleTodo when the checkbox is clicked', () => {
    const onToggleTodo = vi.fn()
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={onToggleTodo} />)
    screen.getByRole('checkbox').click()
    expect(onToggleTodo).toHaveBeenCalledWith(todo)
  })

  it('does not render RSVP controls for a todo', () => {
    render(<EventCard event={todo} viewMode="compact" showRSVP onToggleTodo={vi.fn()} />)
    expect(screen.queryByText(/going/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/EventCard.todo.test.tsx`
Expected: FAIL — no `onToggleTodo` prop, no checkbox rendered.

- [ ] **Step 3: Add the prop, the derived flags, and the checkbox/overdue/strikethrough**

In `src/components/EventCard.tsx`:

Add `onToggleTodo?: (event: Event) => void` to the component's props interface (alongside `onEdit`/`onDelete`).

Just after line 139 (`const isReminder = event.event_kind === 'reminder'`), add:
```ts
  const isTodo = event.event_kind === 'todo'
  const isLean = isReminder || isTodo               // no RSVP / enrollment / memories
  const isDone = isTodo && !!event.completed_at
  const isOverdueTodo = isTodoOverdue(event)
```
Import the helper at the top: add `isTodoOverdue` to the existing `../types/event` import.

**Treat todos as lean.** Replace `!isReminder` with `!isLean` in the guards that gate RSVP / enrollment / memories / ICS — specifically lines 208, 211, 286, 386, 387, 400, 442, 621, 656, 725, 726, 756, 834, 902, 951, 956, 968. Leave the reminder-only badge checks (lines 381, 707, 720) gated on `isReminder` as-is — todos get their own affordances below.

In the **compact** view's title area (around lines 380-387, where the reminder badge / status badge render), add the checkbox and overdue tag. Render a checkbox immediately before the title text, and the overdue tag alongside the badges:
```tsx
{isTodo && (
  <input
    type="checkbox"
    className="h-4 w-4 shrink-0 accent-amber-600"
    checked={isDone}
    onClick={(e) => e.stopPropagation()}
    onChange={() => onToggleTodo?.(event)}
    aria-label={isDone ? 'Mark not done' : 'Mark done'}
  />
)}
{isTodo && isOverdueTodo && (
  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">overdue</span>
)}
```
Apply strikethrough + dim to the title element when `isDone`. Find the compact title span and add to its className:
```tsx
className={`... ${isDone ? 'line-through text-gray-400' : ''}`}
```
Wrap the whole compact card's outer className with a dim when done: append `${isDone ? 'opacity-60' : ''}`.

Repeat the checkbox + overdue tag + strikethrough in the **detailed** view title area (around lines 707-726), mirroring the compact treatment so the card behaves the same in both modes.

- [ ] **Step 4: Add the convert kebab actions**

The kebab menu already renders a `!isReminder` block (line 621) and an actions block. Add a convert item visible for reminders and todos. Inside the kebab portal menu (near the clone/delete block around line 656), add:
```tsx
{(isReminder || isTodo) && onConvertKind && (
  <button
    type="button"
    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
    onClick={() => { onConvertKind(event, isTodo ? 'reminder' : 'todo'); setShowKebabMenu(false) }}
  >
    {isTodo ? 'Convert to reminder' : 'Convert to to-do'}
  </button>
)}
```
Add `onConvertKind?: (event: Event, kind: 'reminder' | 'todo') => void` to the props interface. Also extend `kebabHasItems` (line 285-286) so the kebab shows for todos:
```ts
  const kebabHasItems =
    (!isLean) ||
    (isLean && !!onConvertKind) ||
```
(keep the remaining existing conditions of that expression).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/EventCard.todo.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the existing EventCard/Schedule tests to confirm no regression**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS (reminders still render their badge; the `!isLean` swap didn't break reminder behavior).

- [ ] **Step 7: Commit**

```bash
git add src/components/EventCard.tsx src/components/EventCard.todo.test.tsx
git commit -m "feat(todo): EventCard checkbox, overdue tag, strikethrough, lean layout, convert kebab"
```

---

## Task 9: `CalendarGrid` — amber todo dot + counts + legend

**Files:**
- Modify: `src/components/CalendarGrid.tsx`
- Test: `src/components/CalendarGrid.todo.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/CalendarGrid.todo.test.tsx` (model setup on any existing CalendarGrid render in the suite; if none, render with a single todo on the current month and assert the dot):

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CalendarGrid } from './CalendarGrid'
import { Event } from '../types/event'

function todoOn(dateIso: string): Event {
  return {
    id: 't1', title: 'Pay invoice', description: null,
    start_date: dateIso, end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'todo', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
    completed_at: null, assigned_to: 'u1',
  }
}

describe('CalendarGrid todo dot', () => {
  it('renders a todo dot (amber) for a day with a todo', () => {
    // Use a date in the visible month; the compact cell renders bg-amber-500 dots.
    const today = new Date()
    const iso = new Date(today.getFullYear(), today.getMonth(), 15, 9, 0).toISOString()
    const { container } = render(<CalendarGrid events={[todoOn(iso)]} compact />)
    expect(container.querySelector('.bg-amber-500')).not.toBeNull()
  })
})
```
> Implementer note: match `CalendarGrid`'s actual required props (it takes an events list + display flags). Adjust the render call to whatever the component signature requires; the assertion (an amber dot element exists) is the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/CalendarGrid.todo.test.tsx`
Expected: FAIL — no `.bg-amber-500` element (todos currently fall into the blue "event" count).

- [ ] **Step 3: Implement the todo dot**

In `src/components/CalendarGrid.tsx`, in the per-day computation (lines 203-205), split todos out of the event count:
```ts
const todoCount = dayEvents.filter((e) => e.event_kind === 'todo').length
const eventCount = dayEvents.filter((e) => e.event_kind !== 'reminder' && e.event_kind !== 'todo').length
const reminderCount = dayEvents.filter((e) => e.event_kind === 'reminder').length
```

In the **compact** dots block (lines 240-256), add an amber dot series after the reminder dots, and include todos in the overflow check + aria-label:
```tsx
aria-label={`${eventCount} events, ${reminderCount} reminders, ${todoCount} todos`}
```
```tsx
{Array.from({ length: Math.min(todoCount, DOT_CAP) }).map((_, i) => (
  <span key={`t${i}`} className="h-1.5 w-1.5 rounded-full bg-amber-500" />
))}
```
And extend the overflow condition:
```tsx
{(eventCount > DOT_CAP || reminderCount > DOT_CAP || todoCount > DOT_CAP) && (
  <span className="text-[9px] leading-none text-gray-500">+</span>
)}
```

In the **non-compact** cell (lines 230-238), add an amber dot before the count bubble, mirroring the green reminder dot:
```tsx
{todoCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={`${todoCount} todos`} />}
```

If a legend exists in this component (search for the blue/green legend swatches), add an amber "To-do" entry next to them. If there is no legend element, skip — do not invent one.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/CalendarGrid.todo.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/CalendarGrid.tsx src/components/CalendarGrid.todo.test.tsx
git commit -m "feat(todo): calendar amber todo dots + counts"
```

---

## Task 10: Schedule WeekCard — inline todo checkbox + tag

The WeekCard already renders a per-row `isReminder` tag and reveals a `QuickEventCard` on click. Add an inline checkbox + "to-do" tag for todo rows.

**Files:**
- Modify: `src/components/ScheduleOverview.tsx`
- Test: `src/components/ScheduleOverview.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/components/ScheduleOverview.test.tsx` a case that renders the schedule with a todo in the current week and asserts a checkbox row appears. Reuse the file's existing render harness/fixtures (it already builds events and mounts `ScheduleOverview`); add a todo to the fixture list and assert:
```tsx
it('renders a checkbox for a todo in the week list', async () => {
  // ...add a todo dated within this week to the mocked events, mount ScheduleOverview...
  expect(await screen.findByRole('checkbox', { name: /mark (done|not done)/i })).toBeInTheDocument()
})
```
> Implementer note: the existing test file shows exactly how events are mocked and how `ScheduleOverview` is mounted (it already covers WeekCard + reminder tag). Mirror that; only the todo fixture + assertion are new.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — no checkbox in the week row.

- [ ] **Step 3: Implement the WeekCard row checkbox**

In `ScheduleOverview.tsx`, in `WeekCard` (line 236+), where the row computes `const isReminder = e.event_kind === 'reminder'` (line 265), add:
```ts
const isTodo = e.event_kind === 'todo'
const isDone = isTodo && !!e.completed_at
```
Render a checkbox at the start of the row when `isTodo` (mirror the `RoutinesCard` checkbox at line 178), and a `to-do` tag next to the existing reminder tag (line 292 region). Wire the checkbox to a handler that calls the service and refreshes:
```tsx
{isTodo && (
  <input
    type="checkbox"
    className="h-4 w-4 accent-amber-600"
    checked={isDone}
    onClick={(ev) => ev.stopPropagation()}
    onChange={() => void toggleTodo(e)}
    aria-label={isDone ? 'Mark not done' : 'Mark done'}
  />
)}
```
Add a `toggleTodo` helper in `ScheduleOverview` (near where practices toggle, lines 153-156) that calls the service and triggers the same reload the card uses on edit/delete:
```ts
import { completeTodo, uncompleteTodo } from '../services/eventService' // add to existing imports
// ...
async function toggleTodo(e: Event) {
  if (e.completed_at) await uncompleteTodo(e.id)
  else await completeTodo(e.id)
  onChanged?.() // or whatever reload callback WeekCard already receives via actions
}
```
> Implementer note: WeekCard receives `actions` (ActionProps) and uses them to refresh after edit/delete. Route the post-toggle refresh through that same mechanism (e.g. an `onEdited`/reload callback already threaded into the card) rather than adding new state plumbing. Apply strikethrough to the row title when `isDone` (`line-through text-gray-400`), matching EventCard.

Pass `onToggleTodo`/`onConvertKind` through `QuickEventCard` (line 200) to the inner `EventCard` so the revealed card's checkbox and convert action work too:
```tsx
<EventCard event={event} {...actions} onToggleTodo={(ev) => void toggleTodo(ev)} onConvertKind={handleConvert} viewMode="schedule" />
```
where `handleConvert` calls `convertEventKind` then refreshes. Add `convertEventKind` to the eventService import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat(todo): schedule week rows get inline todo checkbox + tag + convert"
```

---

## Task 11: EventForm — "To-do" kind option

Let users create a todo from the UI. The form already has Event/Reminder kind buttons and a reminder fast-path.

**Files:**
- Modify: `src/components/EventForm.tsx`
- Test: `src/components/EventForm.test.tsx` (extend if present; otherwise create a focused test)

- [ ] **Step 1: Write the failing test**

Add a test that picks the To-do kind and submits, asserting `createEvent`/`onSubmit` receives `event_kind: 'todo'`. Mirror the form's existing test harness (mock `onSubmit`/service, fill title + date). Minimum assertion:
```tsx
it('creates a todo when To-do kind is selected', async () => {
  // render form, click the "To-do" kind button, fill title "Renew passport" + a date, submit
  expect(submitted.event_kind).toBe('todo')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/EventForm.test.tsx`
Expected: FAIL — there is no To-do kind button.

- [ ] **Step 3: Implement the kind option**

In `EventForm.tsx`:

Add a third kind button next to the Event/Reminder buttons (lines 386-404). Mirror the Reminder button, but set `event_kind: 'todo'` and reset to the short flow:
```tsx
<button
  type="button"
  onClick={() => { setFormData((prev) => ({ ...prev, event_kind: 'todo' })); setStep(1) }}
  className={`... ${formData.event_kind === 'todo' ? '<selected styles>' : '<unselected styles>'}`}
>
  To-do
</button>
```
(Copy the exact class strings from the Reminder button so the three buttons match.)

Treat todo like reminder for the simplified flow and field hiding. Everywhere the form branches on `formData.event_kind === 'reminder'` for **flow/step/field-hiding** purposes (lines 182, 288, 301-303, 408-409, 413, 638, 735, 805), change the condition to include todo, e.g.:
```ts
const isLeanKind = formData.event_kind === 'reminder' || formData.event_kind === 'todo'
```
and use `isLeanKind` in those branches. Keep the title/header copy correct:
- Line 357 header: show "Create To-do"/"Edit To-do" when `event_kind === 'todo'`.
- Line 408-409 helper text: when todo, show "A one-off task you check off when done."
- The reminder fast-path "Create reminder" button label (line 641 region): label it "Create to-do" when todo.

Leave the `enrollment_*` clearing (lines 301-303) applied for todo as well (todos have no enrollment) — using `isLeanKind` achieves this.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/EventForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EventForm.tsx src/components/EventForm.test.tsx
git commit -m "feat(todo): EventForm 'To-do' kind option (lean flow like reminder)"
```

---

## Task 12: Full verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole web test suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 2: Run the backend suite**

Run: `cd backend && npx vitest run`
Expected: all green.

- [ ] **Step 3: Type-check + MCP parity + lint**

Run:
```bash
npx tsc -p tsconfig.json --noEmit && node scripts/check-mcp-parity.mjs && npx eslint .
```
Expected: no type errors, `✓ MCP tool parity holds`, no lint errors.

- [ ] **Step 4: Manual smoke (Tier 0)**

Run: `npx plannen up`, open `http://localhost:4321`. Create a To-do dated yesterday → confirm it shows with a checkbox and an "overdue" tag in Schedule, Calendar (amber dot), and Timeline. Tick it → strikethrough + dim, overdue tag gone. Use the kebab to convert it to a reminder → checkbox disappears. Then `npx plannen down`.

- [ ] **Step 5: Update CHANGELOG**

Add under the current unreleased/next section in `CHANGELOG.md`:
```markdown
- **To-do event type.** A new `todo` event kind: a dated, checkable, one-off task with a completion checkbox, shown across Schedule, Calendar (amber dots), and Timeline. Overdue (date passed, still unchecked) is flagged in place; completed todos strike through and dim. Convert between to-do and reminder from the card kebab. Assigned to the creator by default.
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(todo): changelog entry for to-do event type"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** data model (T1), types/resolver/overdue (T2), Tier 0 REST (T3), service ops + creator default (T4), both MCP servers + parity (T5–T7), EventCard checkbox/overdue/strikethrough/lean/convert (T8), Calendar dot (T9), Schedule WeekCard checkbox (T10), create form (T11). Timeline needs no dedicated task — it renders todos through the shared `EventCard` (T8) automatically once `resolveEventStatus` stops hiding them (T2).
- **Out of scope (do not build):** assigning to other users/family members, recurring todos, sub-tasks, undated todos. `assigned_to` is creator-only this phase.
- **Naming is consistent across tasks:** `completed_at`, `assigned_to`, `isTodo`, `isLean`/`isLeanKind`, `isTodoOverdue`, `onToggleTodo`, `onConvertKind`, `completeTodo`, `uncompleteTodo`, `convertEventKind`, `complete_todo`, `uncomplete_todo`.
- **Risk to watch:** the `!isReminder` → `!isLean` swap in EventCard (T8 step 3) is mechanical but wide — run `ScheduleOverview.test.tsx` (T8 step 6) to confirm reminders are unaffected before committing.
