# Shareable Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lean, dateless, agenda-invisible **checklist** primitive (packing/shopping/etc.) — its own tables, MCP tools in both servers, and a web/PWA view — sharable and collaboratively checkable with family/groups.

**Architecture:** Two new tables (`checklists`, `checklist_items`) plus two sharing junctions, deliberately separate from `events` so items never touch any agenda/briefing/calendar query. MCP handlers in **both** servers (`mcp/src/index.ts` Tier 0 + `supabase/functions/mcp/tools/checklists.ts` edge) filter access **explicitly in SQL** (both servers bypass RLS by connecting privileged); Postgres RLS is the safety net for the web/Tier-1 Supabase-direct path. The web consumes a new `checklistService` over the existing `dbClient` tier abstraction, mirroring `practiceService`.

**Tech Stack:** Postgres (Supabase) + RLS; TypeScript MCP servers (Node stdio `pg.Pool` + Deno edge `npm:pg`); React 18 + Vite + React Router v6 + Tailwind; Vitest + React Testing Library.

---

## Naming (locked — keep consistent across all tasks)

- Tables: `plannen.checklists`, `plannen.checklist_items`, `plannen.checklist_shared_with_users`, `plannen.checklist_shared_with_groups`
- Helper fn: `plannen.user_can_access_checklist(p_checklist_id uuid) RETURNS boolean`
- MCP tools (10): `create_checklist`, `add_checklist_items`, `list_checklists`, `get_checklist`, `check_checklist_item`, `uncheck_checklist_item`, `update_checklist_item`, `delete_checklist_item`, `share_checklist`, `delete_checklist`
- Web types: `Checklist`, `ChecklistItem` in `src/types/checklist.ts`
- Web service: `src/services/checklistService.ts`
- Migration file: `supabase/migrations/20260616120000_shareable_checklists.sql`

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `supabase/migrations/20260616120000_shareable_checklists.sql` | Schema: 4 tables, helper fn, RLS | Create |
| `mcp/src/index.ts` | Tier 0 stdio: 10 tool definitions + switch cases + handlers | Modify |
| `mcp/src/checklists.ts` | Pure helpers (position math, access SQL fragment, progress) shared by handlers + unit-tested | Create |
| `mcp/src/checklists.test.ts` | Unit tests for the pure helpers | Create |
| `supabase/functions/mcp/tools/checklists.ts` | Edge ToolModule mirroring the 10 tools | Create |
| `supabase/functions/mcp/index.ts` | Register `checklistsModule` in `TOOLS` | Modify |
| `src/types/checklist.ts` | `Checklist` / `ChecklistItem` interfaces + `checklistProgress()` | Create |
| `src/types/checklist.test.ts` | Unit test for `checklistProgress()` | Create |
| `src/lib/dbClient*.ts` | Add `checklists` namespace to both tier clients | Modify (Phase 2, paths TBD by explorer) |
| `src/services/checklistService.ts` | Service envelope over dbClient | Create |
| `src/services/checklistService.test.ts` | Service unit tests (mock dbClient) | Create |
| `src/hooks/useChecklists.ts`, `src/hooks/useChecklist.ts` | Load + mutate hooks | Create |
| `src/components/ChecklistList.tsx` (+ `.test.tsx`) | List-of-lists w/ progress | Create |
| `src/components/ChecklistDetail.tsx` (+ `.test.tsx`) | Items, tap-to-check, add-item, share | Create |
| `src/pages/Dashboard.tsx` + nav | `?view=checklists` wiring | Modify (Phase 2) |

---

# Phase 1 — Backend (migration + both MCP servers)

This phase delivers the full conversational checklist capability (the user is a heavy Claude-Code user) and is independently shippable and testable.

### Task 1: Migration — tables, helper fn, RLS

**Files:**
- Create: `supabase/migrations/20260616120000_shareable_checklists.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Shareable checklists: a lean, dateless, agenda-invisible list of checkable
-- items. Deliberately NOT todos (event_kind='todo') — checklist items carry no
-- start_date, no status, no recurrence, and never appear in any briefing /
-- list_events / calendar / gcal / watch query because they live in their own
-- tables that those paths never read. A checklist may attach to a trip
-- container (events.event_kind='container') via event_id (ON DELETE SET NULL —
-- detaching never destroys the list) or stand alone. Items die with their list
-- (CASCADE). Fully collaborative when shared: anyone who can access a list can
-- check/add items; checked_by records who ticked each one.
-- Forward-only; no backfill (no checklists exist yet).

-- ── checklists ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklists (
  id          uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  title       text NOT NULL,
  event_id    uuid REFERENCES plannen.events(id) ON DELETE SET NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE plannen.checklists OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklists_created_by ON plannen.checklists (created_by);
CREATE INDEX IF NOT EXISTS idx_checklists_event_id ON plannen.checklists (event_id);

-- ── checklist_items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklist_items (
  id            uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  checklist_id  uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  text          text NOT NULL,
  checked_at    timestamptz,
  checked_by    uuid,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE plannen.checklist_items OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist_id
  ON plannen.checklist_items (checklist_id, position);

-- ── sharing junctions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklist_shared_with_users (
  checklist_id uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checklist_id, user_id)
);
ALTER TABLE plannen.checklist_shared_with_users OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_shared_with_users_user_id
  ON plannen.checklist_shared_with_users (user_id);

CREATE TABLE IF NOT EXISTS plannen.checklist_shared_with_groups (
  checklist_id uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES plannen.friend_groups(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checklist_id, group_id)
);
ALTER TABLE plannen.checklist_shared_with_groups OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_shared_with_groups_group_id
  ON plannen.checklist_shared_with_groups (group_id);

-- ── visibility helper (web/Tier-1 RLS path) ───────────────────────────────────
-- Owner OR directly shared OR member of a shared group. SECURITY DEFINER so it
-- reads the sharing tables regardless of the caller's own RLS.
CREATE OR REPLACE FUNCTION plannen.user_can_access_checklist(p_checklist_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.checklists c
     WHERE c.id = p_checklist_id AND c.created_by = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM plannen.checklist_shared_with_users csu
     WHERE csu.checklist_id = p_checklist_id AND csu.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM plannen.checklist_shared_with_groups csg
      JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
     WHERE csg.checklist_id = p_checklist_id AND fgm.user_id = auth.uid()
  )
$$;
ALTER FUNCTION plannen.user_can_access_checklist(uuid) OWNER TO postgres;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO service_role;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE plannen.checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_shared_with_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_shared_with_groups ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.checklists TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_items TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_shared_with_users TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_shared_with_groups TO anon, authenticated, service_role;

-- checklists: visible to accessors; mutable only by owner.
DROP POLICY IF EXISTS "Accessors can view checklists" ON plannen.checklists;
CREATE POLICY "Accessors can view checklists" ON plannen.checklists
  FOR SELECT USING (plannen.user_can_access_checklist(id));
DROP POLICY IF EXISTS "Owners can insert checklists" ON plannen.checklists;
CREATE POLICY "Owners can insert checklists" ON plannen.checklists
  FOR INSERT WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "Owners can update checklists" ON plannen.checklists;
CREATE POLICY "Owners can update checklists" ON plannen.checklists
  FOR UPDATE USING (created_by = auth.uid());
DROP POLICY IF EXISTS "Owners can delete checklists" ON plannen.checklists;
CREATE POLICY "Owners can delete checklists" ON plannen.checklists
  FOR DELETE USING (created_by = auth.uid());

-- checklist_items: any accessor of the parent list can read AND write.
DROP POLICY IF EXISTS "Accessors can view checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can view checklist_items" ON plannen.checklist_items
  FOR SELECT USING (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can insert checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can insert checklist_items" ON plannen.checklist_items
  FOR INSERT WITH CHECK (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can update checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can update checklist_items" ON plannen.checklist_items
  FOR UPDATE USING (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can delete checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can delete checklist_items" ON plannen.checklist_items
  FOR DELETE USING (plannen.user_can_access_checklist(checklist_id));

-- sharing junctions: owner manages (bare USING also gates INSERT WITH CHECK);
-- the granted party can SELECT the row that grants them access.
DROP POLICY IF EXISTS "Owners manage checklist user-sharing" ON plannen.checklist_shared_with_users;
CREATE POLICY "Owners manage checklist user-sharing" ON plannen.checklist_shared_with_users
  USING (EXISTS (SELECT 1 FROM plannen.checklists c
                 WHERE c.id = checklist_shared_with_users.checklist_id AND c.created_by = auth.uid()));
DROP POLICY IF EXISTS "Shared users see their checklist share" ON plannen.checklist_shared_with_users;
CREATE POLICY "Shared users see their checklist share" ON plannen.checklist_shared_with_users
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners manage checklist group-sharing" ON plannen.checklist_shared_with_groups;
CREATE POLICY "Owners manage checklist group-sharing" ON plannen.checklist_shared_with_groups
  USING (EXISTS (SELECT 1 FROM plannen.checklists c
                 WHERE c.id = checklist_shared_with_groups.checklist_id AND c.created_by = auth.uid()));
DROP POLICY IF EXISTS "Group members see checklist group-sharing" ON plannen.checklist_shared_with_groups;
CREATE POLICY "Group members see checklist group-sharing" ON plannen.checklist_shared_with_groups
  FOR SELECT USING (EXISTS (SELECT 1 FROM plannen.friend_group_members fgm
                            WHERE fgm.group_id = checklist_shared_with_groups.group_id
                              AND fgm.user_id = auth.uid()));

COMMENT ON TABLE plannen.checklists IS 'A lean, dateless list of checkable items (packing/shopping/etc). NOT events — never appears in agenda/briefing/list_events. Optionally attached to a trip container via event_id.';
COMMENT ON TABLE plannen.checklist_items IS 'Items of a checklist: text + checkbox + position. checked_by records who ticked it (no FK; app-resolved like assigned_to). CASCADE-deleted with the list.';
```

- [ ] **Step 2: Verify it applies cleanly against a scratch DB**

Run (uses the embedded Tier 0 Postgres on 54322; applies inside a transaction and rolls back so the live DB is untouched):
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -1 <<'SQL'
BEGIN;
\i supabase/migrations/20260616120000_shareable_checklists.sql
-- prove the tables + constraints exist and CASCADE/SET NULL are wired
SELECT 'tables', count(*) FROM information_schema.tables
  WHERE table_schema='plannen' AND table_name IN
  ('checklists','checklist_items','checklist_shared_with_users','checklist_shared_with_groups');
ROLLBACK;
SQL
```
Expected: prints `tables | 4`, no errors. (If the embedded PG isn't up: `npx plannen up` first, or run against any disposable Postgres with the `plannen`, `extensions`, `auth` stubs.)

- [ ] **Step 3: Commit**
```bash
git add supabase/migrations/20260616120000_shareable_checklists.sql
git commit -m "feat(db): shareable checklists schema (tables + RLS)"
```

---

### Task 2: Pure helpers for MCP handlers (TDD)

The handlers are thin DB wrappers, but three pieces of real logic deserve isolation + tests: the **access predicate SQL fragment**, **next-position math** for appended items, and **progress** counting. Put them in a tiny module the Tier 0 server imports. (The edge server inlines the same SQL — kept in sync by eye + the integration check in Task 6; these helpers are not importable across the Deno/Node build boundary.)

**Files:**
- Create: `mcp/src/checklists.ts`
- Test: `mcp/src/checklists.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { nextPosition, checklistProgress, ACCESSIBLE_CHECKLIST_SQL } from './checklists.js'

describe('nextPosition', () => {
  it('is 0 for an empty list', () => {
    expect(nextPosition([])).toBe(0)
  })
  it('is max(position)+1 otherwise', () => {
    expect(nextPosition([{ position: 0 }, { position: 4 }, { position: 2 }])).toBe(5)
  })
})

describe('checklistProgress', () => {
  it('counts checked vs total', () => {
    expect(checklistProgress([
      { checked_at: null }, { checked_at: '2026-06-16T10:00:00Z' }, { checked_at: null },
    ])).toEqual({ done: 1, total: 3 })
  })
  it('is 0/0 for an empty list', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('ACCESSIBLE_CHECKLIST_SQL', () => {
  it('references the owner column and both sharing tables', () => {
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('created_by')
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('checklist_shared_with_users')
    expect(ACCESSIBLE_CHECKLIST_SQL).toContain('checklist_shared_with_groups')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mcp/src/checklists.test.ts`
Expected: FAIL — `Cannot find module './checklists.js'`.

- [ ] **Step 3: Implement**

```typescript
// mcp/src/checklists.ts — pure helpers shared by the Tier 0 checklist handlers.

/** Next sequential position for an appended item (max existing + 1, else 0). */
export function nextPosition(items: Array<{ position: number }>): number {
  if (items.length === 0) return 0
  return Math.max(...items.map((i) => i.position)) + 1
}

/** {done,total} for a set of items, where checked_at != null means done. */
export function checklistProgress(
  items: Array<{ checked_at: string | null }>,
): { done: number; total: number } {
  return { done: items.filter((i) => i.checked_at != null).length, total: items.length }
}

/**
 * SQL boolean fragment: "is checklist <idCol> accessible to user <userParam>?"
 * Both MCP servers bypass RLS (privileged connection), so access is enforced
 * here in SQL, not by Postgres policies. Caller substitutes the column name and
 * the bound parameter placeholder (e.g. ACCESSIBLE_CHECKLIST_SQL('c.id', '$1')).
 */
export function accessibleChecklistSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc
            WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu
               WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg
               JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
               WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

/** Stable string form used by the smoke test in checklists.test.ts. */
export const ACCESSIBLE_CHECKLIST_SQL = accessibleChecklistSql('$ID', '$USER')
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run mcp/src/checklists.test.ts`
Expected: PASS (3 suites).

- [ ] **Step 5: Commit**
```bash
git add mcp/src/checklists.ts mcp/src/checklists.test.ts
git commit -m "feat(mcp): pure helpers for checklist handlers"
```

---

### Task 3: Tier 0 stdio server — 10 tool definitions + handlers

**Files:**
- Modify: `mcp/src/index.ts` (add 10 entries to the `TOOLS` definitions array; add 10 `case` branches in the `CallToolRequestSchema` switch; add the handler functions; `import` the helpers from `./checklists.js`)

Follow the existing `listEvents` style: a named `async function` that calls `withUserContext(userId, async (c) => {...})` and returns plain data (the shared switch wrapper serialises it to `{content:[{type:'text',text:JSON.stringify(result)}]}`). All access is filtered in SQL via `accessibleChecklistSql(...)`.

- [ ] **Step 1: Add the import** (top of `mcp/src/index.ts`, near other local imports)
```typescript
import { nextPosition, accessibleChecklistSql } from './checklists.js'
```

- [ ] **Step 2: Add the 10 tool definitions** to the `TOOLS` array (each `name:` on its own line so `check-mcp-parity.mjs` detects it)
```typescript
  {
    name: 'create_checklist',
    description: 'Create a lean checklist (packing/shopping/etc). NOT todos — items never appear in the agenda/briefing/list_events. Optionally pass items to fill it in one shot, and event_id to attach it to a trip container.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        event_id: { type: ['string', 'null'], description: 'Container event id to attach to (optional).' },
        items: { type: 'array', items: { type: 'string' }, description: 'Initial item texts, in order.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_checklist_items',
    description: 'Append items to an existing checklist. Allowed for anyone the list is shared with.',
    inputSchema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['checklist_id', 'items'],
    },
  },
  {
    name: 'list_checklists',
    description: 'List checklists you own or that are shared with you, each with {done,total} progress. Optional event_id filters to one trip.',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: ['string', 'null'] } },
    },
  },
  {
    name: 'get_checklist',
    description: 'Get one checklist with its items (ordered) and each item\'s checked_at/checked_by.',
    inputSchema: {
      type: 'object',
      properties: { checklist_id: { type: 'string' } },
      required: ['checklist_id'],
    },
  },
  {
    name: 'check_checklist_item',
    description: 'Tick a checklist item (stamps checked_at + checked_by = you).',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'uncheck_checklist_item',
    description: 'Untick a checklist item (clears checked_at + checked_by).',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'update_checklist_item',
    description: 'Edit a checklist item\'s text.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' }, text: { type: 'string' } },
      required: ['item_id', 'text'],
    },
  },
  {
    name: 'delete_checklist_item',
    description: 'Delete a single checklist item.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'share_checklist',
    description: 'Share a checklist with users and/or friend groups (owner only). Empty arrays are a no-op, never a clear.',
    inputSchema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string' },
        user_ids: { type: 'array', items: { type: 'string' } },
        group_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['checklist_id'],
    },
  },
  {
    name: 'delete_checklist',
    description: 'Delete a checklist and all its items (owner only).',
    inputSchema: {
      type: 'object',
      properties: { checklist_id: { type: 'string' } },
      required: ['checklist_id'],
    },
  },
```

- [ ] **Step 3: Add the switch cases** (in the `CallToolRequestSchema` handler)
```typescript
      case 'create_checklist':        result = await createChecklist(args as Parameters<typeof createChecklist>[0]); break
      case 'add_checklist_items':     result = await addChecklistItems(args as Parameters<typeof addChecklistItems>[0]); break
      case 'list_checklists':         result = await listChecklists(args as Parameters<typeof listChecklists>[0]); break
      case 'get_checklist':           result = await getChecklist(args as Parameters<typeof getChecklist>[0]); break
      case 'check_checklist_item':    result = await setChecklistItemChecked((args as { item_id: string }).item_id, true); break
      case 'uncheck_checklist_item':  result = await setChecklistItemChecked((args as { item_id: string }).item_id, false); break
      case 'update_checklist_item':   result = await updateChecklistItem(args as Parameters<typeof updateChecklistItem>[0]); break
      case 'delete_checklist_item':   result = await deleteChecklistItem((args as { item_id: string }).item_id); break
      case 'share_checklist':         result = await shareChecklist(args as Parameters<typeof shareChecklist>[0]); break
      case 'delete_checklist':        result = await deleteChecklist((args as { checklist_id: string }).checklist_id); break
```

- [ ] **Step 4: Add the handler functions** (near the other tool handlers). `uid()` and `withUserContext` are the existing helpers used by `listEvents`.
```typescript
// ── Checklists ────────────────────────────────────────────────────────────────

async function createChecklist(args: { title: string; event_id?: string | null; items?: string[] }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    if (args.event_id) {
      const { rows: ev } = await c.query(
        `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2 AND event_kind = 'container'`,
        [args.event_id, id],
      )
      if (ev.length === 0) throw new Error('event_id must be a container you own')
    }
    const { rows: cl } = await c.query(
      `INSERT INTO plannen.checklists (title, event_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [args.title, args.event_id ?? null, id],
    )
    const checklist = cl[0]
    const items = (args.items ?? []).filter((t) => t.trim().length > 0)
    let createdItems: unknown[] = []
    if (items.length > 0) {
      const values = items.map((_, i) => `($1, $${i + 2}, ${i})`).join(', ')
      const { rows } = await c.query(
        `INSERT INTO plannen.checklist_items (checklist_id, text, position)
         VALUES ${values} RETURNING *`,
        [checklist.id, ...items],
      )
      createdItems = rows
    }
    return { ...checklist, items: createdItems }
  })
}

async function addChecklistItems(args: { checklist_id: string; items: string[] }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: ok } = await c.query(
      `SELECT 1 WHERE ${accessibleChecklistSql('$1', '$2')}`,
      [args.checklist_id, id],
    )
    if (ok.length === 0) throw new Error('checklist not found or not shared with you')
    const { rows: existing } = await c.query(
      `SELECT position FROM plannen.checklist_items WHERE checklist_id = $1`,
      [args.checklist_id],
    )
    const start = nextPosition(existing as Array<{ position: number }>)
    const items = args.items.filter((t) => t.trim().length > 0)
    if (items.length === 0) return []
    const values = items.map((_, i) => `($1, $${i + 2}, ${start + i})`).join(', ')
    const { rows } = await c.query(
      `INSERT INTO plannen.checklist_items (checklist_id, text, position)
       VALUES ${values} RETURNING *`,
      [args.checklist_id, ...items],
    )
    return rows
  })
}

async function listChecklists(args: { event_id?: string | null }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const params: unknown[] = [id]
    let where = accessibleChecklistSql('cl.id', '$1')
    if (args.event_id) { params.push(args.event_id); where += ` AND cl.event_id = $${params.length}` }
    const { rows } = await c.query(
      `SELECT cl.*,
              COALESCE(i.total, 0)  AS total,
              COALESCE(i.done, 0)   AS done
         FROM plannen.checklists cl
         LEFT JOIN (
           SELECT checklist_id,
                  count(*) AS total,
                  count(checked_at) AS done
             FROM plannen.checklist_items GROUP BY checklist_id
         ) i ON i.checklist_id = cl.id
        WHERE ${where}
        ORDER BY cl.created_at DESC`,
      params,
    )
    return rows
  })
}

async function getChecklist(args: { checklist_id: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: cl } = await c.query(
      `SELECT * FROM plannen.checklists cl WHERE cl.id = $1 AND ${accessibleChecklistSql('cl.id', '$2')}`,
      [args.checklist_id, id],
    )
    if (cl.length === 0) throw new Error('checklist not found or not shared with you')
    const { rows: items } = await c.query(
      `SELECT * FROM plannen.checklist_items WHERE checklist_id = $1 ORDER BY position ASC, created_at ASC`,
      [args.checklist_id],
    )
    return { ...cl[0], items }
  })
}

async function setChecklistItemChecked(itemId: string, checked: boolean) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.checklist_items it
          SET checked_at = ${checked ? 'now()' : 'NULL'},
              checked_by = ${checked ? '$2' : 'NULL'}
        WHERE it.id = $1
          AND ${accessibleChecklistSql('it.checklist_id', '$2')}
        RETURNING *`,
      [itemId, id],
    )
    if (rows.length === 0) throw new Error('item not found or not shared with you')
    return rows[0]
  })
}

async function updateChecklistItem(args: { item_id: string; text: string }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `UPDATE plannen.checklist_items it SET text = $3
        WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')}
        RETURNING *`,
      [args.item_id, id, args.text],
    )
    if (rows.length === 0) throw new Error('item not found or not shared with you')
    return rows[0]
  })
}

async function deleteChecklistItem(itemId: string) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `DELETE FROM plannen.checklist_items it
        WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')}
        RETURNING id`,
      [itemId, id],
    )
    if (rows.length === 0) throw new Error('item not found or not shared with you')
    return { deleted: rows[0].id }
  })
}

async function shareChecklist(args: { checklist_id: string; user_ids?: string[]; group_ids?: string[] }) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows: own } = await c.query(
      `SELECT 1 FROM plannen.checklists WHERE id = $1 AND created_by = $2`,
      [args.checklist_id, id],
    )
    if (own.length === 0) throw new Error('only the owner can share a checklist')
    for (const uid2 of args.user_ids ?? []) {
      await c.query(
        `INSERT INTO plannen.checklist_shared_with_users (checklist_id, user_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [args.checklist_id, uid2],
      )
    }
    for (const gid of args.group_ids ?? []) {
      await c.query(
        `INSERT INTO plannen.checklist_shared_with_groups (checklist_id, group_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [args.checklist_id, gid],
      )
    }
    return { shared: true }
  })
}

async function deleteChecklist(checklistId: string) {
  const id = await uid()
  return await withUserContext(id, async (c) => {
    const { rows } = await c.query(
      `DELETE FROM plannen.checklists WHERE id = $1 AND created_by = $2 RETURNING id`,
      [checklistId, id],
    )
    if (rows.length === 0) throw new Error('checklist not found or you are not the owner')
    return { deleted: rows[0].id }
  })
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b tsconfig.build.json` (or the repo's `npm run build` up to the typecheck step)
Expected: no type errors in `mcp/src/index.ts`.

- [ ] **Step 6: Commit**
```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): checklist tools in the Tier 0 stdio server"
```

---

### Task 4: Edge server — mirror the 10 tools as a ToolModule

**Files:**
- Create: `supabase/functions/mcp/tools/checklists.ts`
- Modify: `supabase/functions/mcp/index.ts` (import + add `checklistsModule` to `TOOLS`)

Mirror the Tier 0 SQL exactly. Edge handlers return raw data (the framework wraps it). `ctx.client` + `ctx.userId` come from `ToolCtx`. The access SQL is inlined here (no cross-build import).

- [ ] **Step 1: Write the module** — `supabase/functions/mcp/tools/checklists.ts`
```typescript
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// SQL boolean: is checklist <idCol> accessible to <userParam>? Both MCP servers
// bypass RLS, so access is enforced here, mirroring mcp/src/checklists.ts.
function accessibleChecklistSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc
            WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu
               WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg
               JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
               WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

const definitions: ToolDefinition[] = [
  /* PASTE the same 10 definition objects from Task 3 Step 2 verbatim (identical
     name/description/inputSchema). They must be byte-equal in name to pass
     check-mcp-parity.mjs. */
]

const createChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { title: string; event_id?: string | null; items?: string[] }
  if (a.event_id) {
    const { rows: ev } = await ctx.client.query(
      `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2 AND event_kind = 'container'`,
      [a.event_id, ctx.userId],
    )
    if (ev.length === 0) throw new Error('event_id must be a container you own')
  }
  const { rows: cl } = await ctx.client.query(
    `INSERT INTO plannen.checklists (title, event_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [a.title, a.event_id ?? null, ctx.userId],
  )
  const checklist = cl[0]
  const items = (a.items ?? []).filter((t) => t.trim().length > 0)
  let createdItems: unknown[] = []
  if (items.length > 0) {
    const values = items.map((_, i) => `($1, $${i + 2}, ${i})`).join(', ')
    const { rows } = await ctx.client.query(
      `INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`,
      [checklist.id, ...items],
    )
    createdItems = rows
  }
  return { ...checklist, items: createdItems }
}

const addChecklistItems: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string; items: string[] }
  const { rows: ok } = await ctx.client.query(
    `SELECT 1 WHERE ${accessibleChecklistSql('$1', '$2')}`, [a.checklist_id, ctx.userId])
  if (ok.length === 0) throw new Error('checklist not found or not shared with you')
  const { rows: existing } = await ctx.client.query(
    `SELECT position FROM plannen.checklist_items WHERE checklist_id = $1`, [a.checklist_id])
  const start = existing.length === 0 ? 0 : Math.max(...existing.map((r: { position: number }) => r.position)) + 1
  const items = a.items.filter((t) => t.trim().length > 0)
  if (items.length === 0) return []
  const values = items.map((_, i) => `($1, $${i + 2}, ${start + i})`).join(', ')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`,
    [a.checklist_id, ...items])
  return rows
}

const listChecklists: ToolHandler = async (args, ctx) => {
  const a = args as { event_id?: string | null }
  const params: unknown[] = [ctx.userId]
  let where = accessibleChecklistSql('cl.id', '$1')
  if (a.event_id) { params.push(a.event_id); where += ` AND cl.event_id = $${params.length}` }
  const { rows } = await ctx.client.query(
    `SELECT cl.*, COALESCE(i.total,0) AS total, COALESCE(i.done,0) AS done
       FROM plannen.checklists cl
       LEFT JOIN (SELECT checklist_id, count(*) AS total, count(checked_at) AS done
                    FROM plannen.checklist_items GROUP BY checklist_id) i ON i.checklist_id = cl.id
      WHERE ${where} ORDER BY cl.created_at DESC`, params)
  return rows
}

const getChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string }
  const { rows: cl } = await ctx.client.query(
    `SELECT * FROM plannen.checklists cl WHERE cl.id = $1 AND ${accessibleChecklistSql('cl.id', '$2')}`,
    [a.checklist_id, ctx.userId])
  if (cl.length === 0) throw new Error('checklist not found or not shared with you')
  const { rows: items } = await ctx.client.query(
    `SELECT * FROM plannen.checklist_items WHERE checklist_id = $1 ORDER BY position ASC, created_at ASC`,
    [a.checklist_id])
  return { ...cl[0], items }
}

async function setItemChecked(ctx: { client: { query: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }> } }, userId: string, itemId: string, checked: boolean) {
  const { rows } = await ctx.client.query(
    `UPDATE plannen.checklist_items it
        SET checked_at = ${checked ? 'now()' : 'NULL'}, checked_by = ${checked ? '$2' : 'NULL'}
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING *`,
    [itemId, userId])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return rows[0]
}

const checkItem: ToolHandler = (args, ctx) => setItemChecked(ctx, ctx.userId, (args as { item_id: string }).item_id, true)
const uncheckItem: ToolHandler = (args, ctx) => setItemChecked(ctx, ctx.userId, (args as { item_id: string }).item_id, false)

const updateItem: ToolHandler = async (args, ctx) => {
  const a = args as { item_id: string; text: string }
  const { rows } = await ctx.client.query(
    `UPDATE plannen.checklist_items it SET text = $3
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING *`,
    [a.item_id, ctx.userId, a.text])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return rows[0]
}

const deleteItem: ToolHandler = async (args, ctx) => {
  const a = args as { item_id: string }
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.checklist_items it
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING id`,
    [a.item_id, ctx.userId])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return { deleted: (rows[0] as { id: string }).id }
}

const shareChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string; user_ids?: string[]; group_ids?: string[] }
  const { rows: own } = await ctx.client.query(
    `SELECT 1 FROM plannen.checklists WHERE id = $1 AND created_by = $2`, [a.checklist_id, ctx.userId])
  if (own.length === 0) throw new Error('only the owner can share a checklist')
  for (const u of a.user_ids ?? [])
    await ctx.client.query(`INSERT INTO plannen.checklist_shared_with_users (checklist_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.checklist_id, u])
  for (const g of a.group_ids ?? [])
    await ctx.client.query(`INSERT INTO plannen.checklist_shared_with_groups (checklist_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.checklist_id, g])
  return { shared: true }
}

const deleteChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string }
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.checklists WHERE id = $1 AND created_by = $2 RETURNING id`, [a.checklist_id, ctx.userId])
  if (rows.length === 0) throw new Error('checklist not found or you are not the owner')
  return { deleted: (rows[0] as { id: string }).id }
}

export const checklistsModule: ToolModule = {
  definitions,
  dispatch: {
    create_checklist: createChecklist,
    add_checklist_items: addChecklistItems,
    list_checklists: listChecklists,
    get_checklist: getChecklist,
    check_checklist_item: checkItem,
    uncheck_checklist_item: uncheckItem,
    update_checklist_item: updateItem,
    delete_checklist_item: deleteItem,
    share_checklist: shareChecklist,
    delete_checklist: deleteChecklist,
  },
}
```

- [ ] **Step 2: Register the module** in `supabase/functions/mcp/index.ts`
```typescript
import { checklistsModule } from './tools/checklists.ts'
// ...and add checklistsModule to the TOOLS array (after eventsModule/activityModule):
const TOOLS: ToolModule[] = [eventsModule, activityModule, checklistsModule, /* …rest unchanged… */]
```

- [ ] **Step 3: Commit**
```bash
git add supabase/functions/mcp/tools/checklists.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): mirror checklist tools in the edge server"
```

---

### Task 5: Parity + full test suite green

- [ ] **Step 1: Run parity**

Run: `npm run check:parity`
Expected: `✓ MCP tool parity holds` and engine parity passes (the engine is untouched). If it reports `create_checklist` (etc.) missing on one side, a `name:` line is mismatched — fix and re-run.

- [ ] **Step 2: Run unit tests + CLI tests**

Run: `npm run test:run && npm run test:cli`
Expected: all pass, including `mcp/src/checklists.test.ts`.

- [ ] **Step 3: Commit any fixes**
```bash
git add -A && git commit -m "test: checklist parity + suite green" --allow-empty
```

---

### Task 6: Apply migration + manual integration smoke (guarded — touches the live DB)

> **Safety gate (CLAUDE.md hard rules):** back up first; never `supabase db reset`. This is the one step that mutates real data — the executor must confirm the backup succeeded before migrating.

- [ ] **Step 1: Back up**

Run (Tier 1): `bash scripts/export-seed.sh`  — or (Tier 0): `tar czf ~/plannen-backup-$(date +%s).tgz -C ~/.plannen pgdata photos`
Expected: a backup artifact is written; note its path.

- [ ] **Step 2: Apply the migration to every active profile**

Run: `npx plannen migrate`
Expected: the new migration applies; no errors. (Tier 1 history-desync? see memory `project_migration_history_desync` — repair, never edit the migration.)

- [ ] **Step 3: Deploy the edge function** (cloud profiles)

Run: `supabase functions deploy mcp --project-ref <ref>` (or `npx plannen up` to restart Tier 1 locally)
Expected: deploy succeeds.

- [ ] **Step 4: Integration smoke via MCP** (in a Claude session against the live MCP)

Create a checklist with items, list it (progress shows), check an item (progress updates), confirm it does **NOT** appear in `list_events` / `get_briefing_context`, then delete it.
Expected: each step behaves; the negative agenda test passes.

---

# Phase 2 — Web / PWA

Every web layer is hand-written per-entity, mirroring `practices`: `dbClient/types.ts` (contract) → `tier0.ts` (Hono REST) + `tier1.ts` (Supabase direct) → `backend/src/routes/api/` (Tier 0 server) → `services/` → hooks → components. Tier 1 leans on the RLS from Task 1 for visibility; Tier 0 filters in SQL (backend bypasses RLS like the MCP servers).

### Task 7: dbClient contract + row types

**Files:**
- Modify: `src/lib/dbClient/types.ts`

- [ ] **Step 1: Add row types** (near `PracticeRow`)
```typescript
export type ChecklistItemRow = {
  id: string
  checklist_id: string
  text: string
  checked_at: string | null
  checked_by: string | null
  position: number
  created_at: string
}

export type ChecklistRow = {
  id: string
  title: string
  event_id: string | null
  created_by: string
  created_at: string
  updated_at: string
  items?: ChecklistItemRow[] // embedded on get/list (tier1) or returned by backend (tier0)
  done?: number              // progress, populated by list
  total?: number
}
```

- [ ] **Step 2: Add the `checklists` namespace to the `DbClient` type** (alongside `practices`)
```typescript
  checklists: {
    list: (params?: { event_id?: string | null }) => Promise<ChecklistRow[]>
    get: (id: string) => Promise<ChecklistRow>
    create: (input: { title: string; event_id?: string | null; items?: string[] }) => Promise<ChecklistRow>
    delete: (id: string) => Promise<void>
    addItems: (id: string, items: string[]) => Promise<ChecklistItemRow[]>
    setItemChecked: (itemId: string, checked: boolean) => Promise<ChecklistItemRow>
    updateItem: (itemId: string, text: string) => Promise<ChecklistItemRow>
    deleteItem: (itemId: string) => Promise<void>
    share: (id: string, input: { user_ids?: string[]; group_ids?: string[] }) => Promise<void>
  }
```

- [ ] **Step 3: Commit** `git add src/lib/dbClient/types.ts && git commit -m "feat(web): dbClient checklist contract + row types"`

### Task 8: Tier 0 dbClient (REST) + Tier 1 dbClient (Supabase)

**Files:**
- Modify: `src/lib/dbClient/tier0.ts`, `src/lib/dbClient/tier1.ts`

- [ ] **Step 1: tier0.ts — add `checklists` namespace** (mirrors the practices `api()`/`qs()` style; `api<T>` already unwraps `{data}`)
```typescript
  checklists: {
    list: (p) => api<ChecklistRow[]>(`/api/checklists${qs({ event_id: p?.event_id ?? undefined })}`),
    get: (id) => api<ChecklistRow>(`/api/checklists/${id}`),
    create: (i) => api<ChecklistRow>('/api/checklists', { method: 'POST', body: JSON.stringify(i) }),
    delete: async (id) => { await api(`/api/checklists/${id}`, { method: 'DELETE' }) },
    addItems: (id, items) => api<ChecklistItemRow[]>(`/api/checklists/${id}/items`, { method: 'POST', body: JSON.stringify({ items }) }),
    setItemChecked: (itemId, checked) => api<ChecklistItemRow>(`/api/checklist-items/${itemId}/checked`, { method: 'PATCH', body: JSON.stringify({ checked }) }),
    updateItem: (itemId, text) => api<ChecklistItemRow>(`/api/checklist-items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
    deleteItem: async (itemId) => { await api(`/api/checklist-items/${itemId}`, { method: 'DELETE' }) },
    share: async (id, input) => { await api(`/api/checklists/${id}/shares`, { method: 'POST', body: JSON.stringify(input) }) },
  },
```
Add `ChecklistRow, ChecklistItemRow` to the existing type import from `./types`.

- [ ] **Step 2: tier1.ts — add `checklists` namespace** (RLS does visibility filtering; `unwrap`/`currentUserId` already imported)
```typescript
  checklists: {
    list: async (params) => {
      let q = supabase.from('checklists').select('*, items:checklist_items(*)').order('created_at', { ascending: false })
      if (params?.event_id) q = q.eq('event_id', params.event_id)
      const rows = unwrap(await q) as ChecklistRow[]
      return rows.map((r) => ({ ...r, total: r.items?.length ?? 0, done: r.items?.filter((i) => i.checked_at != null).length ?? 0 }))
    },
    get: async (id) => {
      const row = unwrap(await supabase.from('checklists').select('*, items:checklist_items(*)').eq('id', id).single()) as ChecklistRow
      row.items = (row.items ?? []).slice().sort((a, b) => a.position - b.position)
      return row
    },
    create: async (input) => {
      const userId = await currentUserId()
      const cl = unwrap(await supabase.from('checklists').insert({ title: input.title, event_id: input.event_id ?? null, created_by: userId }).select().single()) as ChecklistRow
      const texts = (input.items ?? []).filter((t) => t.trim().length > 0)
      cl.items = texts.length
        ? unwrap(await supabase.from('checklist_items').insert(texts.map((text, position) => ({ checklist_id: cl.id, text, position }))).select()) as ChecklistItemRow[]
        : []
      return cl
    },
    delete: async (id) => { const { error } = await supabase.from('checklists').delete().eq('id', id); if (error) throw new Error(error.message) },
    addItems: async (id, items) => {
      const { data: existing } = await supabase.from('checklist_items').select('position').eq('checklist_id', id)
      const start = existing && existing.length ? Math.max(...existing.map((r) => r.position as number)) + 1 : 0
      const rows = items.filter((t) => t.trim().length > 0).map((text, i) => ({ checklist_id: id, text, position: start + i }))
      if (!rows.length) return []
      return unwrap(await supabase.from('checklist_items').insert(rows).select()) as ChecklistItemRow[]
    },
    setItemChecked: async (itemId, checked) => {
      const userId = await currentUserId()
      const patch = checked ? { checked_at: new Date().toISOString(), checked_by: userId } : { checked_at: null, checked_by: null }
      return unwrap(await supabase.from('checklist_items').update(patch).eq('id', itemId).select().single()) as ChecklistItemRow
    },
    updateItem: async (itemId, text) => unwrap(await supabase.from('checklist_items').update({ text }).eq('id', itemId).select().single()) as ChecklistItemRow,
    deleteItem: async (itemId) => { const { error } = await supabase.from('checklist_items').delete().eq('id', itemId); if (error) throw new Error(error.message) },
    share: async (id, input) => {
      if (input.user_ids?.length) { const { error } = await supabase.from('checklist_shared_with_users').upsert(input.user_ids.map((user_id) => ({ checklist_id: id, user_id }))); if (error) throw new Error(error.message) }
      if (input.group_ids?.length) { const { error } = await supabase.from('checklist_shared_with_groups').upsert(input.group_ids.map((group_id) => ({ checklist_id: id, group_id }))); if (error) throw new Error(error.message) }
    },
  },
```

- [ ] **Step 3: Typecheck + commit** `npx tsc -b tsconfig.build.json` then `git add src/lib/dbClient && git commit -m "feat(web): tier0+tier1 checklist data access"`

### Task 9: Tier 0 backend routes

**Files:**
- Create: `backend/src/routes/api/checklists.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the route handlers** (mirror `practices.ts`: Hono + Zod + `withUserContext` + `HttpError` + `c.var.userId`). Access filtered in SQL via the same accessible-checklist predicate as the MCP servers.
```typescript
import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../errors.js'
import type { AppVariables } from '../../types.js'

export const checklists = new Hono<{ Variables: AppVariables }>()

function accessibleSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

const CreateInput = z.object({ title: z.string().min(1), event_id: z.string().uuid().nullish(), items: z.array(z.string()).optional() })
const ItemsInput = z.object({ items: z.array(z.string()) })
const CheckedInput = z.object({ checked: z.boolean() })
const TextInput = z.object({ text: z.string().min(1) })
const ShareInput = z.object({ user_ids: z.array(z.string().uuid()).optional(), group_ids: z.array(z.string().uuid()).optional() })

checklists.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let where = accessibleSql('cl.id', '$1')
    if (eventId) { params.push(eventId); where += ` AND cl.event_id = $${params.length}` }
    const { rows } = await db.query(
      `SELECT cl.*, COALESCE(i.total,0) AS total, COALESCE(i.done,0) AS done
         FROM plannen.checklists cl
         LEFT JOIN (SELECT checklist_id, count(*) AS total, count(checked_at) AS done FROM plannen.checklist_items GROUP BY checklist_id) i ON i.checklist_id = cl.id
        WHERE ${where} ORDER BY cl.created_at DESC`, params)
    return c.json({ data: rows })
  })
})

checklists.get('/:id', async (c) => {
  const userId = c.var.userId; const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows: cl } = await db.query(`SELECT * FROM plannen.checklists cl WHERE cl.id = $1 AND ${accessibleSql('cl.id', '$2')}`, [id, userId])
    if (cl.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    const { rows: items } = await db.query(`SELECT * FROM plannen.checklist_items WHERE checklist_id = $1 ORDER BY position ASC, created_at ASC`, [id])
    return c.json({ data: { ...cl[0], items } })
  })
})

checklists.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid checklist', JSON.stringify(parsed.error.issues))
  const p = parsed.data
  return await withUserContext(userId, async (db) => {
    if (p.event_id) {
      const { rows: ev } = await db.query(`SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2 AND event_kind = 'container'`, [p.event_id, userId])
      if (ev.length === 0) throw new HttpError(400, 'VALIDATION', 'event_id must be a container you own')
    }
    const { rows: cl } = await db.query(`INSERT INTO plannen.checklists (title, event_id, created_by) VALUES ($1,$2,$3) RETURNING *`, [p.title, p.event_id ?? null, userId])
    const texts = (p.items ?? []).filter((t) => t.trim().length > 0)
    let items: unknown[] = []
    if (texts.length) {
      const values = texts.map((_, i) => `($1, $${i + 2}, ${i})`).join(', ')
      items = (await db.query(`INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`, [cl[0].id, ...texts])).rows
    }
    return c.json({ data: { ...cl[0], items } }, 201)
  })
})

checklists.delete('/:id', async (c) => {
  const userId = c.var.userId; const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(`DELETE FROM plannen.checklists WHERE id = $1 AND created_by = $2`, [id, userId])
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    return c.body(null, 204)
  })
})

checklists.post('/:id/items', async (c) => {
  const userId = c.var.userId; const id = c.req.param('id')
  const parsed = ItemsInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid items')
  return await withUserContext(userId, async (db) => {
    const { rows: ok } = await db.query(`SELECT 1 WHERE ${accessibleSql('$1', '$2')}`, [id, userId])
    if (ok.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    const { rows: existing } = await db.query(`SELECT position FROM plannen.checklist_items WHERE checklist_id = $1`, [id])
    const start = existing.length === 0 ? 0 : Math.max(...existing.map((r: { position: number }) => r.position)) + 1
    const texts = parsed.data.items.filter((t) => t.trim().length > 0)
    if (!texts.length) return c.json({ data: [] })
    const values = texts.map((_, i) => `($1, $${i + 2}, ${start + i})`).join(', ')
    const { rows } = await db.query(`INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`, [id, ...texts])
    return c.json({ data: rows }, 201)
  })
})

checklists.patch('/items/:itemId/checked', async (c) => {
  const userId = c.var.userId; const itemId = c.req.param('itemId')
  const parsed = CheckedInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'checked:boolean required')
  const checked = parsed.data.checked
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.checklist_items it SET checked_at = ${checked ? 'now()' : 'NULL'}, checked_by = ${checked ? '$2' : 'NULL'}
        WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')} RETURNING *`, [itemId, userId])
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.json({ data: rows[0] })
  })
})

checklists.patch('/items/:itemId', async (c) => {
  const userId = c.var.userId; const itemId = c.req.param('itemId')
  const parsed = TextInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'text required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(`UPDATE plannen.checklist_items it SET text = $3 WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')} RETURNING *`, [itemId, userId, parsed.data.text])
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.json({ data: rows[0] })
  })
})

checklists.delete('/items/:itemId', async (c) => {
  const userId = c.var.userId; const itemId = c.req.param('itemId')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(`DELETE FROM plannen.checklist_items it WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')}`, [itemId, userId])
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.body(null, 204)
  })
})

checklists.post('/:id/shares', async (c) => {
  const userId = c.var.userId; const id = c.req.param('id')
  const parsed = ShareInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid share input')
  return await withUserContext(userId, async (db) => {
    const { rows: own } = await db.query(`SELECT 1 FROM plannen.checklists WHERE id = $1 AND created_by = $2`, [id, userId])
    if (own.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    for (const u of parsed.data.user_ids ?? []) await db.query(`INSERT INTO plannen.checklist_shared_with_users (checklist_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u])
    for (const g of parsed.data.group_ids ?? []) await db.query(`INSERT INTO plannen.checklist_shared_with_groups (checklist_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, g])
    return c.json({ data: { shared: true } })
  })
})
```
> **Note:** the tier0 dbClient calls `/api/checklist-items/:id` for item ops, but the routes above mount items under `/api/checklists/items/:itemId`. Reconcile during execution: register the item routes on a second Hono app mounted at `/api/checklist-items`, OR change the tier0 paths to `/api/checklists/items/:itemId`. Pick the second (simpler — one route file). Update tier0.ts item paths to `/api/checklists/items/${itemId}` accordingly.

- [ ] **Step 2: Register** in `backend/src/index.ts`
```typescript
import { checklists } from './routes/api/checklists.js'
// ...
app.route('/api/checklists', checklists)
```

- [ ] **Step 3: Typecheck the backend + commit**

Run: `cd backend && npx tsc --noEmit` (or the repo's backend build script)
Then: `git add backend/src/routes/api/checklists.ts backend/src/index.ts src/lib/dbClient/tier0.ts && git commit -m "feat(backend): Tier 0 checklist REST routes"`

### Task 10: Service + progress helper (TDD)

**Files:**
- Create: `src/types/checklist.ts`, `src/types/checklist.test.ts`, `src/services/checklistService.ts`, `src/services/checklistService.test.ts`

- [ ] **Step 1: Failing progress test** (`src/types/checklist.test.ts`)
```typescript
import { describe, it, expect } from 'vitest'
import { checklistProgress } from './checklist'

describe('checklistProgress', () => {
  it('counts checked items', () => {
    expect(checklistProgress([{ checked_at: null }, { checked_at: 'x' }])).toEqual({ done: 1, total: 2 })
  })
  it('is 0/0 when empty', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 })
  })
})
```

- [ ] **Step 2: Implement types + helper** (`src/types/checklist.ts`)
```typescript
import type { ChecklistItemRow } from '../lib/dbClient/types'
export type { ChecklistRow as Checklist, ChecklistItemRow as ChecklistItem } from '../lib/dbClient/types'

export function checklistProgress(items: Array<Pick<ChecklistItemRow, 'checked_at'>>): { done: number; total: number } {
  return { done: items.filter((i) => i.checked_at != null).length, total: items.length }
}
```

- [ ] **Step 3: Service** (`src/services/checklistService.ts`)
```typescript
import { dbClient } from '../lib/dbClient'
import type { ChecklistRow, ChecklistItemRow } from '../lib/dbClient/types'

export const listChecklists = (eventId?: string | null): Promise<ChecklistRow[]> => dbClient.checklists.list({ event_id: eventId ?? undefined })
export const getChecklist = (id: string): Promise<ChecklistRow> => dbClient.checklists.get(id)
export const createChecklist = (input: { title: string; event_id?: string | null; items?: string[] }): Promise<ChecklistRow> => dbClient.checklists.create(input)
export const deleteChecklist = (id: string): Promise<void> => dbClient.checklists.delete(id)
export const addChecklistItems = (id: string, items: string[]): Promise<ChecklistItemRow[]> => dbClient.checklists.addItems(id, items)
export const setChecklistItemChecked = (itemId: string, checked: boolean): Promise<ChecklistItemRow> => dbClient.checklists.setItemChecked(itemId, checked)
export const updateChecklistItem = (itemId: string, text: string): Promise<ChecklistItemRow> => dbClient.checklists.updateItem(itemId, text)
export const deleteChecklistItem = (itemId: string): Promise<void> => dbClient.checklists.deleteItem(itemId)
export const shareChecklist = (id: string, input: { user_ids?: string[]; group_ids?: string[] }): Promise<void> => dbClient.checklists.share(id, input)
```

- [ ] **Step 4: Service test** (`src/services/checklistService.test.ts`, mirrors `eventService.test.ts` `vi.hoisted` mock)
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { create, setItemChecked } = vi.hoisted(() => ({
  create: vi.fn(async (i: unknown) => ({ id: 'c1', items: [], ...(i as object) })),
  setItemChecked: vi.fn(async (id: string, checked: boolean) => ({ id, checked_at: checked ? 'now' : null })),
}))
vi.mock('../lib/dbClient', () => ({ dbClient: { checklists: { create, setItemChecked } } }))

import { createChecklist, setChecklistItemChecked } from './checklistService'

beforeEach(() => { create.mockClear(); setItemChecked.mockClear() })

describe('checklistService', () => {
  it('createChecklist forwards title + items', async () => {
    await createChecklist({ title: 'Packing', items: ['socks'] })
    expect(create).toHaveBeenCalledWith({ title: 'Packing', items: ['socks'] })
  })
  it('setChecklistItemChecked passes the checked flag', async () => {
    await setChecklistItemChecked('i1', true)
    expect(setItemChecked).toHaveBeenCalledWith('i1', true)
  })
})
```

- [ ] **Step 5: Run + commit**

Run: `npx vitest run src/types/checklist.test.ts src/services/checklistService.test.ts`
Expected: PASS. Then `git add src/types/checklist.ts src/types/checklist.test.ts src/services/checklistService.ts src/services/checklistService.test.ts && git commit -m "feat(web): checklist service + progress helper"`

### Task 11: Hooks

**Files:**
- Create: `src/hooks/useChecklists.ts`, `src/hooks/useChecklist.ts`

- [ ] **Step 1: `useChecklists.ts`** (list + create + delete; mirrors `useTodayRoutines` load/refresh shape)
```typescript
import { useCallback, useEffect, useState } from 'react'
import type { ChecklistRow } from '../lib/dbClient/types'
import { listChecklists, createChecklist, deleteChecklist } from '../services/checklistService'

export function useChecklists(eventId?: string | null) {
  const [checklists, setChecklists] = useState<ChecklistRow[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setChecklists(await listChecklists(eventId)); setLoading(false)
  }, [eventId])
  useEffect(() => {
    let cancelled = false
    void load().catch((e) => { if (!cancelled) console.error('useChecklists: load failed', e) })
    return () => { cancelled = true }
  }, [load])
  const create = useCallback(async (input: { title: string; event_id?: string | null; items?: string[] }) => { await createChecklist(input); await load() }, [load])
  const remove = useCallback(async (id: string) => { await deleteChecklist(id); await load() }, [load])
  return { checklists, loading, reload: load, create, remove }
}
```

- [ ] **Step 2: `useChecklist.ts`** (single list detail with optimistic check toggle)
```typescript
import { useCallback, useEffect, useState } from 'react'
import type { ChecklistRow } from '../lib/dbClient/types'
import { getChecklist, setChecklistItemChecked, addChecklistItems, deleteChecklistItem } from '../services/checklistService'

export function useChecklist(id: string) {
  const [checklist, setChecklist] = useState<ChecklistRow | null>(null)
  const load = useCallback(async () => setChecklist(await getChecklist(id)), [id])
  useEffect(() => {
    let cancelled = false
    void load().catch((e) => { if (!cancelled) console.error('useChecklist: load failed', e) })
    return () => { cancelled = true }
  }, [load])
  const toggle = useCallback(async (itemId: string, checked: boolean) => {
    setChecklist((c) => c && { ...c, items: c.items?.map((i) => i.id === itemId ? { ...i, checked_at: checked ? new Date().toISOString() : null } : i) })
    await setChecklistItemChecked(itemId, checked); await load()
  }, [load])
  const addItems = useCallback(async (texts: string[]) => { await addChecklistItems(id, texts); await load() }, [id, load])
  const removeItem = useCallback(async (itemId: string) => { await deleteChecklistItem(itemId); await load() }, [load])
  return { checklist, reload: load, toggle, addItems, removeItem }
}
```

- [ ] **Step 3: Commit** `git add src/hooks/useChecklist*.ts && git commit -m "feat(web): checklist hooks"`

### Task 12: Components (TDD)

**Files:**
- Create: `src/components/ChecklistList.tsx` (+ `.test.tsx`), `src/components/ChecklistDetail.tsx`, `src/components/ChecklistItemRow.tsx`

- [ ] **Step 1: Failing test for ChecklistList** (`src/components/ChecklistList.test.tsx`, mirrors `EventList.test.tsx`)
```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChecklistList } from './ChecklistList'
import type { ChecklistRow } from '../lib/dbClient/types'

function makeList(o: Partial<ChecklistRow> = {}): ChecklistRow {
  return { id: 'c1', title: 'Packing', event_id: null, created_by: 'u1', created_at: '', updated_at: '', done: 1, total: 3, ...o }
}

describe('ChecklistList', () => {
  it('renders each list title and its progress', () => {
    render(<ChecklistList checklists={[makeList()]} onOpen={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('Packing')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })
  it('calls onOpen when a list is clicked', () => {
    const onOpen = vi.fn()
    render(<ChecklistList checklists={[makeList()]} onOpen={onOpen} onDelete={vi.fn()} />)
    screen.getByText('Packing').click()
    expect(onOpen).toHaveBeenCalledWith('c1')
  })
  it('shows the empty state with no lists', () => {
    render(<ChecklistList checklists={[]} onOpen={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(/no checklists/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement `ChecklistList.tsx`** (Tailwind, mirrors EventList empty-state + ProfileRoutines card)
```tsx
import type { ChecklistRow } from '../lib/dbClient/types'

interface Props {
  checklists: ChecklistRow[]
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}

export function ChecklistList({ checklists, onOpen, onDelete }: Props) {
  if (checklists.length === 0) {
    return <div className="text-center py-12"><p className="text-gray-500">No checklists yet.</p></div>
  }
  return (
    <div className="w-full max-w-2xl mx-auto space-y-3">
      {checklists.map((cl) => {
        const total = cl.total ?? 0; const done = cl.done ?? 0
        const pct = total ? Math.round((done / total) * 100) : 0
        return (
          <div key={cl.id} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <button type="button" onClick={() => onOpen(cl.id)} className="flex-1 text-left font-semibold text-gray-900 truncate">{cl.title}</button>
              <span className="text-xs text-gray-500 tabular-nums">{done}/{total}</span>
              <button type="button" onClick={() => onDelete(cl.id)} aria-label="Delete checklist" className="text-gray-300 hover:text-red-500">×</button>
            </div>
            <div className="mt-2 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Implement `ChecklistItemRow.tsx`** (checkbox row, mirrors `Today.tsx` checkbox)
```tsx
import type { ChecklistItemRow as Item } from '../lib/dbClient/types'

interface Props { item: Item; onToggle: (id: string, checked: boolean) => void; onDelete: (id: string) => void }

export function ChecklistItemRow({ item, onToggle, onDelete }: Props) {
  const checked = item.checked_at != null
  return (
    <li className="flex items-center gap-3 min-h-[44px] py-1">
      <input type="checkbox" className="h-5 w-5 flex-shrink-0" checked={checked}
        onChange={() => onToggle(item.id, !checked)}
        aria-label={checked ? 'Uncheck item' : 'Check item'} />
      <span className={`flex-1 ${checked ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.text}</span>
      <button type="button" onClick={() => onDelete(item.id)} aria-label="Delete item" className="text-gray-300 hover:text-red-500">×</button>
    </li>
  )
}
```

- [ ] **Step 4: Implement `ChecklistDetail.tsx`** (uses `useChecklist`; items + add-item input). Share control is a deferred sub-step — wire `shareChecklist` behind a button when the group-picker component is identified during execution (reuse the existing event share-picker; grep `event_shared_with_groups` usages in `src/components`).
```tsx
import { useState } from 'react'
import { useChecklist } from '../hooks/useChecklist'
import { ChecklistItemRow } from './ChecklistItemRow'

export function ChecklistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { checklist, toggle, addItems, removeItem } = useChecklist(id)
  const [draft, setDraft] = useState('')
  if (!checklist) return <div className="py-12 text-center text-gray-400">Loading…</div>
  const submit = async () => {
    const texts = draft.split('\n').map((t) => t.trim()).filter(Boolean)
    if (texts.length) { await addItems(texts); setDraft('') }
  }
  return (
    <div className="w-full max-w-2xl mx-auto">
      <button type="button" onClick={onBack} className="text-sm text-indigo-600 mb-3">← Back</button>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">{checklist.title}</h2>
      <ul className="space-y-1">
        {checklist.items?.map((it) => (
          <ChecklistItemRow key={it.id} item={it} onToggle={toggle} onDelete={removeItem} />
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Add an item…" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <button type="button" onClick={() => void submit()} className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm">Add</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run component tests + commit**

Run: `npx vitest run src/components/ChecklistList.test.tsx`
Expected: PASS. Then `git add src/components/Checklist*.tsx src/components/ChecklistList.test.tsx && git commit -m "feat(web): checklist components"`

### Task 13: Dashboard view + nav

**Files:**
- Modify: `src/pages/Dashboard.tsx` (add a `checklists` value to the `?view=` switch and a nav entry, mirroring how `stories`/`groups` views are wired)

- [ ] **Step 1: Add the view branch** — render a small container that holds local `openId` state: when null show `<ChecklistList>` (+ a "New checklist" button that calls `useChecklists().create`), else `<ChecklistDetail id={openId} onBack={() => setOpenId(null)} />`. Wire it exactly like the existing `view === 'stories'` branch (find it in `Dashboard.tsx` and copy the structure). Add a nav button labelled "Checklists".

```tsx
// inside Dashboard, near other view components:
function ChecklistsView() {
  const { checklists, create, remove } = useChecklists()
  const [openId, setOpenId] = useState<string | null>(null)
  if (openId) return <ChecklistDetail id={openId} onBack={() => setOpenId(null)} />
  return (
    <div className="space-y-4">
      <div className="max-w-2xl mx-auto flex justify-end">
        <button type="button" onClick={() => void create({ title: 'New checklist' })} className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm">New checklist</button>
      </div>
      <ChecklistList checklists={checklists} onOpen={setOpenId} onDelete={(id) => void remove(id)} />
    </div>
  )
}
// ...and in the view switch: {view === 'checklists' && <ChecklistsView />}
```
Add the imports (`useState`, `useChecklists`, `ChecklistList`, `ChecklistDetail`) at the top of `Dashboard.tsx`.

- [ ] **Step 2: Typecheck, lint, full suite**

Run: `npm run build && npm run lint && npm run test:run`
Expected: all green.

- [ ] **Step 3: Commit** `git add src/pages/Dashboard.tsx && git commit -m "feat(web): checklists dashboard view + nav"`

### Task 14: End-to-end verification

- [ ] **Step 1: Bring the stack up**

Run: `npx plannen up` (Tier 0: pg 54322 + backend 54323 + web 4321)
Expected: all three start. (Migration from Task 6 already applied.)

- [ ] **Step 2: Manual smoke in the web app** (port 4321)

Open `/dashboard?view=checklists`. Create "Packing" with items (swim clothes, sunscreen, socks); tick one → progress bar + `done/total` update; add an item; reload → state persists; delete the list. Confirm checklist items do **not** appear in the Today/agenda views.

- [ ] **Step 3: Final commit / branch wrap**

Run: `npm run check:parity && npm run test:run`
Then finish the branch per `superpowers:finishing-a-development-branch` (PR `feat/shareable-checklists`).

---

## Self-review notes

- **Spec coverage:** 2 tables + 2 sharing junctions (Task 1) ✓; agenda-invisibility — own tables, negative tests in Task 6/14 ✓; one-shot create-and-fill (Task 3/9 `items[]`) ✓; collaborative check+add with `checked_by` (RLS + handlers) ✓; sharing users+groups (Task 3/4/9) ✓; web view + trip integration (Task 12/13; trip panel reuses `list_checklists({event_id})` — a follow-up wires it onto the container page, noted as deferred) ✓; explicit OUTs (assignment, sections, templates) untouched ✓.
- **Deferred within plan (flagged, not silent):** the trip-container *panel* embedding and the share-picker UI reuse are stubbed to existing components during execution (Task 12 Step 4, Task 13). Core sharing works via MCP + tier1 immediately.
- **Type consistency:** `ChecklistRow`/`ChecklistItemRow` are the single source (dbClient/types.ts); `src/types/checklist.ts` re-exports them as `Checklist`/`ChecklistItem`. MCP tool names are identical across both servers (parity-checked). Item-route path mismatch between tier0.ts and the backend is explicitly called out in Task 9 with the chosen reconciliation.
