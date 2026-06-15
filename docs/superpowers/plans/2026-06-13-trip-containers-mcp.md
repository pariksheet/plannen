# Trip Containers — Plan 1: Data Model + MCP Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `container` event kind and a `group_id` link so events and todos can be bundled under one umbrella (a "Trip"), driven entirely from the MCP tools both servers expose.

**Architecture:** The container is itself a row in `plannen.events` (`event_kind='container'`), reusing the existing multi-day band rendering, memories, and notes. A new nullable `group_id` column points children at their container; a new `list_label` column buckets a trip's todos. All behaviour lands in the two MCP servers (`mcp/src/index.ts` local + `supabase/functions/mcp/tools/events.ts` edge) — no new tool, only new params on `create_event`, `update_event`, `list_events`.

**Tech Stack:** PostgreSQL (forward-only SQL migration), TypeScript (Node `pg` for local server, Deno for edge function), vitest, the `plannen` CLI.

**Spec:** `docs/superpowers/specs/2026-06-13-trip-containers-design.md`

---

## Testing approach (read first)

This slice is almost entirely DB-glue. The repo's existing convention is that the
`create_event` / `update_event` / `list_events` handlers are **not** unit-tested
(there is no in-repo DB harness for the MCP handlers — only pure logic like
`scheduling.ts` / `recurrence.ts` has vitest coverage). This plan follows that
convention deliberately: it verifies the slice with (1) `tsc` builds, (2) the
parity + engine guard scripts, and (3) a Tier 0 integration smoke against the
embedded Postgres using `psql`. Do not invent a mock-DB harness for the handlers
— that would be scope creep inconsistent with the surrounding code.

The MCP tool-parity guard (`scripts/check-mcp-parity.mjs`) compares **tool
names**, not params. We add no new tool, so parity stays green by construction —
but the integration smoke in Task 5 confirms both new params actually work.

---

## Task 1: Migration — add `container` kind + `group_id` + `list_label`

**Files:**
- Create: `supabase/migrations/20260613130000_trip_containers.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260613130000_trip_containers.sql` with exactly:

```sql
-- Trip containers: a container event groups child events + todos under one
-- umbrella (a "Trip"). The container is itself an events row
-- (event_kind='container'); children point at it via group_id.
-- Forward-only; no backfill (no containers exist yet).

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_event_kind_check";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_event_kind_check"
  CHECK (("event_kind" = ANY (ARRAY['event'::"text", 'reminder'::"text", 'session'::"text", 'todo'::"text", 'container'::"text"])));

ALTER TABLE "plannen"."events"
  ADD COLUMN IF NOT EXISTS "group_id" "uuid"
  REFERENCES "plannen"."events"("id") ON DELETE SET NULL;
ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "list_label" "text";

CREATE INDEX IF NOT EXISTS "idx_events_group_id" ON "plannen"."events" ("group_id");

COMMENT ON COLUMN "plannen"."events"."group_id" IS 'For child events/todos: the container (event_kind=container) they belong to. ON DELETE SET NULL — deleting a container detaches children, never destroys them. Orthogonal to parent_event_id (which is recurrence-session-only). A container''s own group_id must be NULL (no nested trips).';
COMMENT ON COLUMN "plannen"."events"."list_label" IS 'For event_kind=todo inside a container: the named list bucket (e.g. Packing / To-do / Shopping). Free-text. NULL/unused otherwise.';
```

- [ ] **Step 2: Apply it to the active Tier 0 profile**

Run:
```bash
npx plannen migrate
```
Expected: output lists `20260613130000_trip_containers.sql` as applied, exits 0.

- [ ] **Step 3: Verify the schema took**

Run:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d+ plannen.events" | grep -E "group_id|list_label"
```
Expected: two rows showing `group_id | uuid` and `list_label | text`.

Run:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "INSERT INTO plannen.events (title, start_date, event_kind, created_by) SELECT 'kindcheck', now(), 'container', id FROM plannen.users LIMIT 1 RETURNING id;"
```
Expected: one row returned (the `container` kind is accepted). Clean up:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "DELETE FROM plannen.events WHERE title='kindcheck';"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613130000_trip_containers.sql
git commit -m "feat(db): trip-container columns — event_kind=container, group_id, list_label"
```

---

## Task 2: Local MCP server (`mcp/src/index.ts`)

**Files:**
- Modify: `mcp/src/index.ts` — `createEvent` (223-311), `updateEvent` (313-357), `listEvents` (114-138), tool schemas `list_events` (2545), `create_event` (2575), `update_event` (2611)

### 2a — `createEvent`: accept container kind, group_id, list_label, inheritance

- [ ] **Step 1: Extend the args type**

In `createEvent` (line 223), add three fields to the args type:

```typescript
async function createEvent(args: {
  title: string
  description?: string
  start_date: string
  end_date?: string
  location?: string
  event_kind?: string
  enrollment_url?: string
  hashtags?: string[]
  event_status?: string
  recurrence_rule?: RecurrenceRule
  assigned_to?: string
  subject_kind?: 'family_member' | 'user'
  subject_id?: string
  owner_attends?: boolean
  group_id?: string | null
  list_label?: string
}) {
```

- [ ] **Step 2: Resolve the kind and validate/inherit from the container**

Replace the body from `return await withUserContext(id, async (c) => {` (line 249)
down to the end of the INSERT call. The new block resolves the kind (now
including `'container'`), looks up the container when `group_id` is set, rejects
nesting, and inherits `event_type` / sharing. Replace lines 249-276 with:

```typescript
  const resolvedKind =
    args.event_kind === 'reminder' || args.event_kind === 'todo' || args.event_kind === 'container'
      ? args.event_kind
      : 'event'

  return await withUserContext(id, async (c) => {
    const hashtags = (args.hashtags ?? []).slice(0, 5)

    // Default sharing; overridden by inheritance when joining a container.
    let eventType = 'personal'
    let sharedWithFamily = false
    let sharedWithFriends = 'none'
    if (args.group_id != null) {
      if (resolvedKind === 'container') throw new Error('a container cannot belong to another container')
      const { rows: cont } = await c.query(
        `SELECT event_kind, event_type, shared_with_family, shared_with_friends
         FROM plannen.events WHERE id = $1 AND created_by = $2`,
        [args.group_id, id],
      )
      if (cont.length === 0 || cont[0].event_kind !== 'container') {
        throw new Error('group_id must reference a container you own')
      }
      eventType = cont[0].event_type
      sharedWithFamily = cont[0].shared_with_family
      sharedWithFriends = cont[0].shared_with_friends
    }

    const { rows } = await c.query(
      `INSERT INTO plannen.events
         (title, description, start_date, end_date, location, event_kind,
          enrollment_url, hashtags, event_type, event_status, created_by,
          assigned_to, shared_with_family, shared_with_friends, recurrence_rule,
          subject_kind, subject_id, owner_attends, group_id, list_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        args.title,
        args.description ?? null,
        startDate.toISOString(),
        endDate ? endDate.toISOString() : null,
        args.location ?? null,
        resolvedKind,
        args.enrollment_url ?? null,
        hashtags,
        eventType,
        event_status,
        id,
        resolvedKind === 'todo' ? (args.assigned_to ?? id) : null,
        sharedWithFamily,
        sharedWithFriends,
        args.recurrence_rule ?? null,
        args.subject_kind ?? null,
        args.subject_id ?? null,
        args.owner_attends ?? false,
        args.group_id ?? null,
        resolvedKind === 'todo' ? (args.list_label ?? null) : null,
      ],
    )
```

Leave the rest of `createEvent` (the `if (rows.length === 0)` guard, the
`recurrence_rule` session loop, the `upsertSource` call, and the
`return { ...slimEvent(data), source }`) unchanged. The session-insert loop must
NOT set `group_id`/`list_label` — recurrence sessions belong to their parent via
`parent_event_id`, not to a trip.

- [ ] **Step 3: Build the local server**

Run:
```bash
cd mcp && npm run build && cd ..
```
Expected: `tsc` exits 0, no type errors.

### 2b — `updateEvent`: assign/detach group_id, set list_label

- [ ] **Step 4: Extend the args type**

In `updateEvent` (line 313), add two fields:

```typescript
async function updateEvent(args: {
  id: string
  title?: string
  description?: string
  start_date?: string
  end_date?: string
  location?: string
  event_status?: string
  enrollment_url?: string
  subject_kind?: 'family_member' | 'user' | null
  subject_id?: string | null
  owner_attends?: boolean
  group_id?: string | null
  list_label?: string | null
}) {
```

- [ ] **Step 5: Validate group_id before the generic SET-clause build**

The existing handler builds `entries` from `rest` and writes each key as a column
(so `group_id` / `list_label` flow into the UPDATE automatically; `null` is
allowed because the filter is `v !== undefined`). Add validation at the top of
the `withUserContext` callback. Replace line 335
(`return await withUserContext(id, async (c) => {`) and the immediately following
`const setClauses` line with:

```typescript
  return await withUserContext(id, async (c) => {
    if (rest.group_id != null) {
      const { rows: tgt } = await c.query(
        `SELECT event_kind FROM plannen.events WHERE id = $1 AND created_by = $2`,
        [args.id, id],
      )
      if (tgt.length === 0) throw new Error('Not found')
      if (tgt[0].event_kind === 'container') throw new Error('a container cannot belong to another container')
      const { rows: cont } = await c.query(
        `SELECT event_kind FROM plannen.events WHERE id = $1 AND created_by = $2`,
        [rest.group_id, id],
      )
      if (cont.length === 0 || cont[0].event_kind !== 'container') {
        throw new Error('group_id must reference a container you own')
      }
    }
    const setClauses: string[] = []
```

Leave the remainder of `updateEvent` (the entries loop, `updated_at` clause, the
UPDATE, `upsertSource`, return) unchanged.

### 2c — `listEvents`: add group_id filter

- [ ] **Step 6: Add the filter**

In `listEvents` (line 114), extend the args type and WHERE building. Change the
signature to:

```typescript
async function listEvents(args: { status?: string; limit?: number; from_date?: string; to_date?: string; fields?: 'summary' | 'full'; group_id?: string }) {
```

Then immediately after the existing `to_date` filter line (line 121) add:

```typescript
    if (args.group_id) { params.push(args.group_id); where.push(`group_id = $${params.length}`) }
```

### 2d — Tool schemas

- [ ] **Step 7: Update the three tool input schemas**

In the `TOOLS` array:

`list_events` (line 2545) — add inside `properties` (after `fields`):
```typescript
        group_id: { type: 'string', description: 'Return only members of this container/trip (its child events + todos). Pass the container event id. Remember to also raise limit (default 10 truncates).' },
```

`create_event` (line 2575) — change the `event_kind` enum and add two properties:
```typescript
        event_kind: { type: 'string', enum: ['event', 'reminder', 'todo', 'container'] },
```
and after the `hashtags` property add:
```typescript
        group_id: { type: 'string', description: 'Container/trip this event or todo belongs to (a container event id). Child inherits the container event_type + sharing unless this event is itself a container. A container cannot have a group_id.' },
        list_label: { type: 'string', description: 'For event_kind=todo inside a container: which named list it belongs to (e.g. Packing, To-do, Shopping). Ignored for non-todos.' },
```
Also update the `create_event` description string (line 2576) to:
```typescript
    description: 'Create an event, reminder, todo, or container (a multi-day "Trip" that groups child events + todos via their group_id) in Plannen',
```

`update_event` (line 2611) — add inside `properties` (after `owner_attends`):
```typescript
        group_id: { type: 'string', description: 'Assign this event/todo into a container/trip (pass the container event id), or null to remove it from its trip. Cannot be set on a container itself.' },
        list_label: { type: 'string', description: 'For a todo inside a container: its named list bucket (e.g. Packing). null clears it.' },
```

- [ ] **Step 8: Build + commit**

Run:
```bash
cd mcp && npm run build && cd ..
```
Expected: `tsc` exits 0.

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp-local): container kind + group_id/list_label on event tools"
```

---

## Task 3: Edge MCP server (`supabase/functions/mcp/tools/events.ts`)

This MUST mirror Task 2 — it is the server Claude Code actually talks to in
Tier 1/2. The two servers share no code (separate build graphs), so the logic is
hand-duplicated; byte-identical is NOT required here (only the scheduling engine
files are byte-locked).

**Files:**
- Modify: `supabase/functions/mcp/tools/events.ts` — `createEvent` (274-363), `updateEvent` (365-407), `listEvents` (193-222), schemas `create_event` (66), `update_event` (110), `list_events` (18)

### 3a — `createEvent` handler

- [ ] **Step 1: Extend the args type + resolve/inherit/insert**

In `createEvent` (line 274), add to the `a` type:
```typescript
    group_id?: string | null
    list_label?: string
```

Replace the block from `const hashtags = (a.hashtags ?? []).slice(0, 5)`
(line 303) through the end of the INSERT call (line 329) with:

```typescript
  const resolvedKind =
    a.event_kind === 'reminder' || a.event_kind === 'todo' || a.event_kind === 'container'
      ? a.event_kind
      : 'event'

  const hashtags = (a.hashtags ?? []).slice(0, 5)

  let eventType = 'personal'
  let sharedWithFamily = false
  let sharedWithFriends = 'none'
  if (a.group_id != null) {
    if (resolvedKind === 'container') throw new Error('a container cannot belong to another container')
    const { rows: cont } = await ctx.client.query(
      `SELECT event_kind, event_type, shared_with_family, shared_with_friends
       FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [a.group_id, ctx.userId],
    )
    if (cont.length === 0 || cont[0].event_kind !== 'container') {
      throw new Error('group_id must reference a container you own')
    }
    eventType = cont[0].event_type
    sharedWithFamily = cont[0].shared_with_family
    sharedWithFriends = cont[0].shared_with_friends
  }

  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.events
       (title, description, start_date, end_date, location, event_kind,
        enrollment_url, hashtags, event_type, event_status, created_by,
        assigned_to, shared_with_family, shared_with_friends, recurrence_rule,
        subject_kind, subject_id, owner_attends, group_id, list_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING *`,
    [
      a.title,
      a.description ?? null,
      startDate.toISOString(),
      endDate ? endDate.toISOString() : null,
      a.location ?? null,
      resolvedKind,
      a.enrollment_url ?? null,
      hashtags,
      eventType,
      event_status,
      ctx.userId,
      resolvedKind === 'todo' ? (a.assigned_to ?? ctx.userId) : null,
      sharedWithFamily,
      sharedWithFriends,
      a.recurrence_rule ?? null,
      a.subject_kind ?? null,
      a.subject_id ?? null,
      a.owner_attends ?? false,
      a.group_id ?? null,
      resolvedKind === 'todo' ? (a.list_label ?? null) : null,
    ],
  )
```

Leave the `if (rows.length === 0)`, the session loop, `upsertSource`, and return
unchanged. The session loop must NOT set `group_id`/`list_label`.

### 3b — `updateEvent` handler

- [ ] **Step 2: Extend args type + validate group_id**

In `updateEvent` (line 365), add to the `a` type:
```typescript
    group_id?: string | null
    list_label?: string | null
```

This handler has no `withUserContext` wrapper — it uses `ctx.client` directly and
builds SQL inline. Insert validation immediately after the destructure
`const { id: _id, ...rest } = a` (line 379), before the timezone block:

```typescript
  if (rest.group_id != null) {
    const { rows: tgt } = await ctx.client.query(
      `SELECT event_kind FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [a.id, ctx.userId],
    )
    if (tgt.length === 0) throw new Error('Not found')
    if (tgt[0].event_kind === 'container') throw new Error('a container cannot belong to another container')
    const { rows: cont } = await ctx.client.query(
      `SELECT event_kind FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [rest.group_id, ctx.userId],
    )
    if (cont.length === 0 || cont[0].event_kind !== 'container') {
      throw new Error('group_id must reference a container you own')
    }
  }
```

The generic entries loop already turns `group_id`/`list_label` in `rest` into SET
clauses (with `null` allowed, since the filter is `v !== undefined`). No further
change to the loop.

### 3c — `listEvents` handler

- [ ] **Step 3: Add group_id filter**

In `listEvents` (line 193), add `group_id?: string` to the `a` type, then after
the `to_date` filter (line 206) add:
```typescript
  if (a.group_id) { params.push(a.group_id); where.push(`group_id = $${params.length}`) }
```

### 3d — Schemas (in the `definitions` array)

- [ ] **Step 4: Mirror the three schema changes**

`list_events` (line 18) — add inside `properties`:
```typescript
        group_id: { type: 'string', description: 'Return only members of this container/trip (its child events + todos). Pass the container event id. Remember to also raise limit (default 10 truncates).' },
```

`create_event` (line 66) — change `event_kind` enum to include `'container'`,
update the description to:
```typescript
    description: 'Create an event, reminder, todo, or container (a multi-day "Trip" that groups child events + todos via their group_id) in Plannen',
```
and add after `hashtags`:
```typescript
        group_id: { type: 'string', description: 'Container/trip this event or todo belongs to (a container event id). Child inherits the container event_type + sharing unless this event is itself a container. A container cannot have a group_id.' },
        list_label: { type: 'string', description: 'For event_kind=todo inside a container: which named list it belongs to (e.g. Packing, To-do, Shopping). Ignored for non-todos.' },
```

`update_event` (line 110) — add after `owner_attends`:
```typescript
        group_id: { type: 'string', description: 'Assign this event/todo into a container/trip (pass the container event id), or null to remove it from its trip. Cannot be set on a container itself.' },
        list_label: { type: 'string', description: 'For a todo inside a container: its named list bucket (e.g. Packing). null clears it.' },
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/events.ts
git commit -m "feat(mcp-edge): mirror container kind + group_id/list_label on event tools"
```

---

## Task 4: Web type union tolerates containers

So the web build (and any consumer) doesn't choke when a `container` row appears.
Rendering stays in Plan 2 — this is only the type widening.

**Files:**
- Modify: `src/types/event.ts:3`

- [ ] **Step 1: Widen `EventKind` and add the new columns**

Change line 3:
```typescript
export type EventKind = 'event' | 'reminder' | 'session' | 'todo' | 'container'
```
In the `Event` interface, after `assigned_to?: string | null` (line 30) add:
```typescript
  group_id?: string | null
  list_label?: string | null
```

- [ ] **Step 2: Type-check the web build**

Run:
```bash
npx tsc -b tsconfig.build.json
```
Expected: exits 0 (the union widening doesn't break existing `switch`/equality
uses; nothing exhaustively matches `EventKind` without a default).

- [ ] **Step 3: Commit**

```bash
git add src/types/event.ts
git commit -m "feat(web-types): add 'container' EventKind + group_id/list_label"
```

---

## Task 5: Guards + Tier 0 integration smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Parity + engine guards still green**

Run:
```bash
npm run check:parity
```
Expected: both `check-mcp-parity.mjs` and `check-engine-parity.mjs` exit 0 (no
tool drift — we added params, not tools; no engine files touched).

- [ ] **Step 2: CLI test suite**

Run:
```bash
npm run test:cli
```
Expected: passes (includes the MCP-parity test).

- [ ] **Step 3: Tier 0 integration smoke — exercise both new params end-to-end**

Bring the stack up if not already:
```bash
npx plannen up
```

Then run this SQL smoke directly against embedded Postgres. It mimics what the
handlers do (create a container, a grouped child + a grouped todo with a label,
list members, then delete the container and confirm children detach):

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres <<'SQL'
\set ON_ERROR_STOP on
DO $$
DECLARE uid uuid; cid uuid; child uuid; todo uuid;
BEGIN
  SELECT id INTO uid FROM plannen.users LIMIT 1;

  INSERT INTO plannen.events (title, start_date, end_date, event_kind, event_type, shared_with_family, created_by)
    VALUES ('Trip smoke', now(), now() + interval '14 days', 'container', 'family', true, uid)
    RETURNING id INTO cid;

  INSERT INTO plannen.events (title, start_date, event_kind, event_type, shared_with_family, created_by, group_id)
    VALUES ('Beach day', now() + interval '2 days', 'event', 'family', true, uid, cid)
    RETURNING id INTO child;

  INSERT INTO plannen.events (title, start_date, event_kind, created_by, group_id, list_label, assigned_to)
    VALUES ('Pack sunscreen', now() + interval '1 day', 'todo', uid, cid, 'Packing', uid)
    RETURNING id INTO todo;

  RAISE NOTICE 'members of trip: %',
    (SELECT count(*) FROM plannen.events WHERE group_id = cid);  -- expect 2

  DELETE FROM plannen.events WHERE id = cid;

  RAISE NOTICE 'child group_id after container delete: %',
    (SELECT group_id FROM plannen.events WHERE id = child);      -- expect NULL
  RAISE NOTICE 'child survived: %',
    (SELECT count(*) FROM plannen.events WHERE id = child);       -- expect 1

  DELETE FROM plannen.events WHERE id IN (child, todo);
END $$;
SQL
```
Expected NOTICES: `members of trip: 2`, `child group_id after container delete: <empty>` (NULL), `child survived: 1`. No errors.

- [ ] **Step 4: Live MCP smoke (the real surface)**

In a Claude Code session connected to this profile, confirm the tools accept the
new params:
- `create_event` with `event_kind:"container"`, a `title`, `start_date`, and an
  `end_date` two weeks out → returns a row with `event_kind:"container"`.
- `create_event` with `event_kind:"todo"`, `group_id:<container id>`,
  `list_label:"Packing"` → returns a todo; `list_events({ group_id:<id>, limit:50 })`
  includes it.
- `update_event` with `group_id:null` on that todo → detaches it (no longer in
  `list_events({group_id})`).
- `create_event` with `event_kind:"container"` AND a `group_id` → errors with
  "a container cannot belong to another container".

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(trip-containers): Tier 0 integration smoke verified"
```

---

## Plan 2 preview (not in scope here)

Plan 2 (`docs/superpowers/plans/...-trip-containers-web.md`, to be written after
Plan 1 lands) covers the web hub: a trip-membership visual cue on child events in
`CalendarGrid.tsx`, and a trip detail panel that lists child activities + named
todo-list buckets (grouped by `list_label`) with check-off via the existing
`complete_todo`/`uncomplete_todo`. It will need exploration of the existing event
detail / form components first. The `list_label` case-insensitive bucketing
default lives there (UI concern).
```
