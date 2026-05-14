# Plannen Kitchen Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `plannen-kitchen` — a sibling Claude Code plugin that adds weekly grocery, pantry, and meal-plan reasoning. Plannen core's surface is untouched; the kitchen plugin lives in `plugins/plannen-kitchen/` with its own schema (`kitchen.*`), MCP server, plugin manifest, skills, commands, and one mobile-first web page.

**Architecture:** Sibling plugin model. Each MCP tool exposes structured CRUD/query only — Claude does all parsing, matching, and meal-plan reasoning via skills. Plannen's web app gains a generic `src/plugins/` slot that auto-mounts any plugin UI file dropped in; kitchen's `install.sh` symlinks its UI into that slot. Opt-in install via `bootstrap.sh --plugin plannen-kitchen`.

**Tech Stack:** TypeScript (MCP server), Supabase Postgres (`kitchen.*` schema, `@supabase/supabase-js`), Vitest, React + Vite (web UI), Markdown (plugin skills/commands), Bash (install/bootstrap).

**Spec:** `docs/superpowers/specs/2026-05-14-plannen-kitchen-plugin-design.md`

---

## File structure

Files this plan creates or modifies:

```
plugins/plannen-kitchen/
├── .claude-plugin/plugin.json                                NEW — manifest
├── mcp/
│   ├── package.json                                          NEW
│   ├── tsconfig.json                                         NEW
│   ├── src/
│   │   ├── index.ts                                          NEW — server entry, tool dispatch
│   │   ├── client.ts                                         NEW — Supabase client + uid helper
│   │   ├── stores.ts                                         NEW — store handlers
│   │   ├── lists.ts                                          NEW — list handlers
│   │   ├── items.ts                                          NEW — item handlers
│   │   ├── pantry.ts                                         NEW — pantry/history handlers
│   │   ├── helpers.ts                                        NEW — pure validation helpers
│   │   ├── helpers.test.ts                                   NEW — vitest unit tests
│   │   └── tools.ts                                          NEW — TOOLS array (schema definitions)
├── supabase/migrations/
│   └── 20260514000000_kitchen_initial.sql                    NEW — schema + tables + view + indexes
├── skills/
│   ├── kitchen-shop.md                                       NEW
│   ├── kitchen-pantry.md                                     NEW
│   └── kitchen-meal-plan.md                                  NEW
├── commands/
│   ├── kitchen-list.md                                       NEW — /kitchen-list
│   └── kitchen-shop.md                                       NEW — /kitchen-shop
├── web/
│   ├── kitchen.tsx                                           NEW — entry export
│   ├── ShopView.tsx                                          NEW — main page
│   └── supabase.ts                                           NEW — kitchen-schema client
├── install.sh                                                NEW
├── uninstall.sh                                              NEW
└── README.md                                                 NEW

src/plugins/index.ts                                          NEW — Plannen web app plugin slot (~30 lines)

src/routes/AppRoutes.tsx                                      MODIFY — iterate plugins[]
src/components/<nav file>                                     MODIFY — iterate plugins[] for nav (file TBD in Task 16)

scripts/bootstrap.sh                                          MODIFY — add --plugin flag
```

Why these boundaries:

- `mcp/src/` is split by domain (stores/lists/items/pantry) — each file holds related handlers; `index.ts` is the thin server-wiring entry. Keeps files under ~200 lines and lets Task N modify only one domain's file.
- `helpers.ts` is the pure-function module (no Supabase imports). It's the only file with unit tests — the DB-touching handlers are verified via the end-to-end smoke test (Task 25). This matches the existing Plannen pattern (`mcp/src/sources.ts` + `mcp/src/sources.test.ts`).
- `tools.ts` separates the `Tool[]` schema array from handler implementations so the schemas can be edited without touching handler code.
- `web/` files mirror Plannen's existing `src/` patterns: `supabase.ts` for the client, `ShopView.tsx` for the page component, `kitchen.tsx` for the plugin-slot entry export.

---

## Task 1: Kitchen schema migration

Create the `kitchen` schema with `stores`, `lists`, `items` tables and the `pantry` view. RLS not needed (Plannen is single-user local; same posture as `plannen.*`).

**Files:**
- Create: `plugins/plannen-kitchen/supabase/migrations/20260514000000_kitchen_initial.sql`

- [ ] **Step 1: Write the migration file**

Create `plugins/plannen-kitchen/supabase/migrations/20260514000000_kitchen_initial.sql`:

```sql
-- plannen-kitchen — initial schema.
--
-- Adds the `kitchen` Postgres schema with three tables (stores, lists, items)
-- and one view (pantry). RLS is intentionally not enabled — Plannen is single-
-- user local, same posture as `plannen.*`.
--
-- Forward-only. Never edit this file in place; add a new timestamped migration
-- on top.

CREATE SCHEMA IF NOT EXISTS "kitchen";
ALTER SCHEMA "kitchen" OWNER TO "postgres";
COMMENT ON SCHEMA "kitchen" IS 'plannen-kitchen plugin schema — grocery lists, items, stores, pantry view.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.stores
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('supermarket','bakery','local','online','other')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.stores IS 'Stores where items are bought. Free-form name; type controlled.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.lists
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  week_of    date,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.lists IS 'A weekly (or one-off) shopping list. status=active is the current one in flight.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.items
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id    uuid NOT NULL REFERENCES kitchen.lists(id) ON DELETE CASCADE,
  name       text NOT NULL,
  qty        text,
  store_id   uuid REFERENCES kitchen.stores(id) ON DELETE SET NULL,
  aisle      text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','skipped')),
  picked_at  timestamptz,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.items IS 'One row per item on a list. status=picked + picked_at feed the pantry view.';

-- ──────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ──────────────────────────────────────────────────────────────────────────────

CREATE INDEX items_list_id_status     ON kitchen.items(list_id, status);
CREATE INDEX items_name_picked_at     ON kitchen.items(lower(name), picked_at DESC) WHERE status = 'picked';
CREATE INDEX items_picked_at          ON kitchen.items(picked_at DESC)              WHERE status = 'picked';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.pantry view
-- ──────────────────────────────────────────────────────────────────────────────

CREATE VIEW kitchen.pantry AS
  SELECT
    i.id,
    i.name,
    i.qty,
    i.store_id,
    s.name      AS store_name,
    i.picked_at,
    (now() - i.picked_at) AS age
  FROM kitchen.items i
  LEFT JOIN kitchen.stores s ON s.id = i.store_id
  WHERE i.status = 'picked' AND i.picked_at IS NOT NULL
  ORDER BY i.picked_at DESC;

COMMENT ON VIEW kitchen.pantry IS 'Derived: items marked picked, ordered by most-recently-bought. age is now()-picked_at.';

-- ──────────────────────────────────────────────────────────────────────────────
-- API exposure for PostgREST (so the Supabase JS client can hit kitchen.* from
-- the web UI with the anon key). The MCP server uses the service-role key and
-- doesn't depend on this.
-- ──────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA kitchen TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA kitchen TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA kitchen TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kitchen GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kitchen GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
```

- [ ] **Step 2: Verify migration syntax (dry-run on a scratch DB)**

The migration applies via Plannen's existing `supabase migration up` once the install script symlinks it (Task 20). For now just verify the SQL parses by running:

```bash
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f plugins/plannen-kitchen/supabase/migrations/20260514000000_kitchen_initial.sql --single-transaction --set ON_ERROR_STOP=on -v ECHO=errors -c "ROLLBACK;"
```

If `supabase start` isn't running, skip — the migration will be exercised end-to-end in Task 25. If it does run, expected output: a series of `CREATE` lines followed by `ROLLBACK`, no errors.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/supabase/migrations/20260514000000_kitchen_initial.sql
git commit -m "kitchen: initial schema migration (stores, lists, items, pantry view)"
```

---

## Task 2: MCP package scaffold

Set up `plugins/plannen-kitchen/mcp/` as its own TypeScript subpackage that builds to `mcp/dist/index.js`. Mirrors the existing Plannen MCP layout.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/package.json`
- Create: `plugins/plannen-kitchen/mcp/tsconfig.json`
- Create: `plugins/plannen-kitchen/mcp/.gitignore`

- [ ] **Step 1: Write `package.json`**

Create `plugins/plannen-kitchen/mcp/package.json`:

```json
{
  "name": "plannen-kitchen-mcp",
  "version": "0.1.0",
  "description": "MCP server for plannen-kitchen — grocery lists, pantry, meal-plan reasoning.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@supabase/supabase-js": "^2.49.4",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "tsx": "^4.19.3",
    "typescript": "^5.8.3",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

Create `plugins/plannen-kitchen/mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `.gitignore`**

Create `plugins/plannen-kitchen/mcp/.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 4: Install deps**

```bash
cd plugins/plannen-kitchen/mcp && npm install
```

Expected: deps installed, `node_modules/` present, no errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/plannen-kitchen/mcp/package.json plugins/plannen-kitchen/mcp/tsconfig.json plugins/plannen-kitchen/mcp/.gitignore plugins/plannen-kitchen/mcp/package-lock.json
git commit -m "kitchen: scaffold MCP subpackage"
```

---

## Task 3: MCP Supabase client + uid helper

Single shared module that exports a service-role Supabase client scoped to the `kitchen` schema, plus a `uid()` helper that resolves the Plannen user from `PLANNEN_USER_EMAIL`. Mirrors Plannen MCP's pattern.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/client.ts`

- [ ] **Step 1: Write the client module**

Create `plugins/plannen-kitchen/mcp/src/client.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// .env lives at repo root. From plugins/plannen-kitchen/mcp/src/client.ts the
// path is four parents up.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../../../.env') })

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const USER_EMAIL = (process.env.PLANNEN_USER_EMAIL ?? '').toLowerCase()

function fatal(msg: string): never {
  process.stderr.write(`[plannen-kitchen-mcp] ${msg}\n`)
  process.exit(1)
}

if (!SERVICE_ROLE_KEY) fatal('SUPABASE_SERVICE_ROLE_KEY is required')
if (!USER_EMAIL) fatal('PLANNEN_USER_EMAIL is required')

export const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'kitchen' },
})

let _userId: string | null = null

export async function uid(): Promise<string> {
  if (_userId) return _userId
  const { data, error } = await db.auth.admin.listUsers()
  if (error) throw new Error(`Auth error: ${error.message}`)
  const user = data.users.find(u => u.email?.toLowerCase() === USER_EMAIL)
  if (!user) {
    throw new Error(
      `No Plannen account found for ${USER_EMAIL}. Sign in to the Plannen app at least once first.`
    )
  }
  _userId = user.id
  return _userId
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: no output (clean compile).

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/client.ts
git commit -m "kitchen-mcp: Supabase client + uid helper"
```

---

## Task 4: Pure validation helpers + tests

Pure functions extracted for unit testing without a database. Covers store-type validation, list-status validation, item-status validation, and `days` parameter defaulting.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/helpers.ts`
- Test: `plugins/plannen-kitchen/mcp/src/helpers.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/plannen-kitchen/mcp/src/helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  STORE_TYPES,
  LIST_STATUSES,
  ITEM_STATUSES,
  validateStoreType,
  validateListStatus,
  validateItemStatus,
  validateName,
  resolveDays,
} from './helpers.js'

describe('validateStoreType', () => {
  it('accepts every member of STORE_TYPES', () => {
    for (const t of STORE_TYPES) expect(validateStoreType(t)).toBe(t)
  })
  it('throws on unknown type', () => {
    expect(() => validateStoreType('hypermarket')).toThrow(/invalid type/)
  })
  it('throws on empty string', () => {
    expect(() => validateStoreType('')).toThrow(/invalid type/)
  })
})

describe('validateListStatus', () => {
  it('accepts every member of LIST_STATUSES', () => {
    for (const s of LIST_STATUSES) expect(validateListStatus(s)).toBe(s)
  })
  it('throws on unknown status', () => {
    expect(() => validateListStatus('frozen')).toThrow(/invalid status/)
  })
})

describe('validateItemStatus', () => {
  it('accepts every member of ITEM_STATUSES', () => {
    for (const s of ITEM_STATUSES) expect(validateItemStatus(s)).toBe(s)
  })
  it('throws on unknown status', () => {
    expect(() => validateItemStatus('done')).toThrow(/invalid status/)
  })
})

describe('validateName', () => {
  it('returns trimmed name', () => {
    expect(validateName('  milk  ')).toBe('milk')
  })
  it('throws "name required" for empty string', () => {
    expect(() => validateName('')).toThrow('name required')
  })
  it('throws "name required" for whitespace-only string', () => {
    expect(() => validateName('   ')).toThrow('name required')
  })
})

describe('resolveDays', () => {
  it('defaults to 14 when undefined', () => {
    expect(resolveDays(undefined)).toBe(14)
  })
  it('returns the supplied value when valid', () => {
    expect(resolveDays(7)).toBe(7)
    expect(resolveDays(30)).toBe(30)
  })
  it('throws on zero', () => {
    expect(() => resolveDays(0)).toThrow(/days must be positive/)
  })
  it('throws on negative', () => {
    expect(() => resolveDays(-1)).toThrow(/days must be positive/)
  })
  it('caps at 365', () => {
    expect(() => resolveDays(366)).toThrow(/days must be <= 365/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/plannen-kitchen/mcp && npx vitest run src/helpers.test.ts
```

Expected: FAIL with import error (`./helpers.js` not found).

- [ ] **Step 3: Write the implementation**

Create `plugins/plannen-kitchen/mcp/src/helpers.ts`:

```ts
export const STORE_TYPES = ['supermarket', 'bakery', 'local', 'online', 'other'] as const
export const LIST_STATUSES = ['active', 'completed', 'archived'] as const
export const ITEM_STATUSES = ['pending', 'picked', 'skipped'] as const

export type StoreType = typeof STORE_TYPES[number]
export type ListStatus = typeof LIST_STATUSES[number]
export type ItemStatus = typeof ITEM_STATUSES[number]

export function validateStoreType(value: unknown): StoreType {
  if (typeof value !== 'string' || !(STORE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`invalid type: ${value}; expected one of ${STORE_TYPES.join(', ')}`)
  }
  return value as StoreType
}

export function validateListStatus(value: unknown): ListStatus {
  if (typeof value !== 'string' || !(LIST_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid status: ${value}; expected one of ${LIST_STATUSES.join(', ')}`)
  }
  return value as ListStatus
}

export function validateItemStatus(value: unknown): ItemStatus {
  if (typeof value !== 'string' || !(ITEM_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid status: ${value}; expected one of ${ITEM_STATUSES.join(', ')}`)
  }
  return value as ItemStatus
}

export function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name required')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('name required')
  return trimmed
}

export function resolveDays(value: number | undefined): number {
  if (value === undefined) return 14
  if (value <= 0) throw new Error('days must be positive')
  if (value > 365) throw new Error('days must be <= 365')
  return value
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/plannen-kitchen/mcp && npx vitest run src/helpers.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/helpers.ts plugins/plannen-kitchen/mcp/src/helpers.test.ts
git commit -m "kitchen-mcp: validation helpers with unit tests"
```

---

## Task 5: Store handlers

Implement four store tools: `add_store`, `list_stores`, `update_store`, `delete_store`. These are pure CRUD over `kitchen.stores`.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/stores.ts`

- [ ] **Step 1: Write the handlers**

Create `plugins/plannen-kitchen/mcp/src/stores.ts`:

```ts
import { db } from './client.js'
import { validateName, validateStoreType, type StoreType } from './helpers.js'

export async function addStore(args: { name: string; type: string; notes?: string }) {
  const name = validateName(args.name)
  const type = validateStoreType(args.type)
  const { data, error } = await db
    .from('stores')
    .insert({ name, type, notes: args.notes ?? null })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listStores(args: { type?: string }) {
  let q = db.from('stores').select('id, name, type, notes, created_at').order('name', { ascending: true })
  if (args.type) {
    const type = validateStoreType(args.type)
    q = q.eq('type', type)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function updateStore(args: { store_id: string; name?: string; type?: string; notes?: string }) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.type !== undefined) patch.type = validateStoreType(args.type)
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('stores')
    .update(patch)
    .eq('id', args.store_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteStore(args: { store_id: string }) {
  const { error } = await db.from('stores').delete().eq('id', args.store_id)
  if (error) throw new Error(error.message)
  return { ok: true }
}
```

- [ ] **Step 2: Verify type-check**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/stores.ts
git commit -m "kitchen-mcp: store handlers (add, list, update, delete)"
```

---

## Task 6: List handlers

Implement `create_list`, `list_lists`, `update_list`. Lists are the parent of items.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/lists.ts`

- [ ] **Step 1: Write the handlers**

Create `plugins/plannen-kitchen/mcp/src/lists.ts`:

```ts
import { db } from './client.js'
import { validateListStatus, validateName } from './helpers.js'

export async function createList(args: { name: string; week_of?: string; notes?: string }) {
  const name = validateName(args.name)
  const { data, error } = await db
    .from('lists')
    .insert({
      name,
      week_of: args.week_of ?? null,
      notes: args.notes ?? null,
      status: 'active',
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listLists(args: { status?: string; limit?: number }) {
  const limit = args.limit ?? 10
  let q = db
    .from('lists')
    .select('id, name, week_of, status, notes, created_at')
    .order('created_at', { ascending: false })
    .limit(limit + 1)
  if (args.status) {
    const status = validateListStatus(args.status)
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data ?? []
  const truncated = rows.length > limit
  const out = truncated ? rows.slice(0, limit) : rows

  // Enrich with item counts in a single batched query per page.
  if (out.length === 0) return { lists: [], truncated }
  const listIds = out.map(l => l.id)
  const { data: counts, error: cErr } = await db
    .from('items')
    .select('list_id, status')
    .in('list_id', listIds)
  if (cErr) throw new Error(cErr.message)

  const byList = new Map<string, { total: number; picked: number }>()
  for (const id of listIds) byList.set(id, { total: 0, picked: 0 })
  for (const row of counts ?? []) {
    const entry = byList.get(row.list_id)
    if (!entry) continue
    entry.total += 1
    if (row.status === 'picked') entry.picked += 1
  }

  return {
    lists: out.map(l => ({
      ...l,
      item_count: byList.get(l.id)?.total ?? 0,
      picked_count: byList.get(l.id)?.picked ?? 0,
    })),
    truncated,
  }
}

export async function updateList(args: { list_id: string; name?: string; status?: string; notes?: string }) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.status !== undefined) patch.status = validateListStatus(args.status)
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('lists')
    .update(patch)
    .eq('id', args.list_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}
```

- [ ] **Step 2: Type-check**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/lists.ts
git commit -m "kitchen-mcp: list handlers (create, list, update)"
```

---

## Task 7: Item handlers

Implement `add_item`, `list_items`, `update_item`, `check_off_item`, `delete_item`. Most of the kitchen action goes through these.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/items.ts`

- [ ] **Step 1: Write the handlers**

Create `plugins/plannen-kitchen/mcp/src/items.ts`:

```ts
import { db } from './client.js'
import { validateItemStatus, validateName } from './helpers.js'

export async function addItem(args: {
  list_id: string
  name: string
  qty?: string
  store_id?: string
  aisle?: string
  notes?: string
}) {
  const name = validateName(args.name)
  const { data, error } = await db
    .from('items')
    .insert({
      list_id: args.list_id,
      name,
      qty: args.qty ?? null,
      store_id: args.store_id ?? null,
      aisle: args.aisle ?? null,
      notes: args.notes ?? null,
      status: 'pending',
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listItems(args: { list_id: string; status?: string }) {
  let q = db
    .from('items')
    .select(`
      id, list_id, name, qty, store_id, aisle, status, picked_at, notes,
      stores ( name, type )
    `)
    .eq('list_id', args.list_id)
    .order('aisle', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (args.status) {
    const status = validateItemStatus(args.status)
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    list_id: row.list_id,
    name: row.name,
    qty: row.qty,
    store_id: row.store_id,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    aisle: row.aisle,
    status: row.status,
    picked_at: row.picked_at,
    notes: row.notes,
  }))
}

export async function updateItem(args: {
  item_id: string
  name?: string
  qty?: string
  store_id?: string | null
  aisle?: string | null
  notes?: string | null
}) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.qty !== undefined) patch.qty = args.qty
  if (args.store_id !== undefined) patch.store_id = args.store_id
  if (args.aisle !== undefined) patch.aisle = args.aisle
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('items')
    .update(patch)
    .eq('id', args.item_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function checkOffItem(args: { item_id: string }) {
  const { data, error } = await db
    .from('items')
    .update({ status: 'picked', picked_at: new Date().toISOString() })
    .eq('id', args.item_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteItem(args: { item_id: string }) {
  const { error } = await db.from('items').delete().eq('id', args.item_id)
  if (error) throw new Error(error.message)
  return { ok: true }
}
```

- [ ] **Step 2: Type-check**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/items.ts
git commit -m "kitchen-mcp: item handlers (add, list, update, check-off, delete)"
```

---

## Task 8: Pantry + history handlers

Implement `list_pantry` (reads the view) and `get_item_history` (queries past picked items by name).

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/pantry.ts`

- [ ] **Step 1: Write the handlers**

Create `plugins/plannen-kitchen/mcp/src/pantry.ts`:

```ts
import { db } from './client.js'
import { resolveDays, validateName } from './helpers.js'

export async function listPantry(args: { days?: number }) {
  const days = resolveDays(args.days)
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('pantry')
    .select('id, name, qty, store_id, store_name, picked_at, age')
    .gte('picked_at', cutoff)
    .order('picked_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getItemHistory(args: { name: string; limit?: number }) {
  const name = validateName(args.name).toLowerCase()
  const limit = args.limit ?? 5
  const { data, error } = await db
    .from('items')
    .select(`
      id, name, qty, aisle, picked_at,
      stores ( id, name, type ),
      lists ( id, name, week_of )
    `)
    .eq('status', 'picked')
    .ilike('name', name)
    .order('picked_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    qty: row.qty,
    aisle: row.aisle,
    picked_at: row.picked_at,
    store_id: row.stores?.id ?? null,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    list_id: row.lists?.id ?? null,
    list_name: row.lists?.name ?? null,
    list_week_of: row.lists?.week_of ?? null,
  }))
}
```

- [ ] **Step 2: Type-check**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/pantry.ts
git commit -m "kitchen-mcp: pantry + history handlers"
```

---

## Task 9: Tool schemas (TOOLS array)

The `Tool[]` array consumed by `ListToolsRequestSchema`. Separated from handlers so schemas can be tweaked without scrolling past code.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/tools.ts`

- [ ] **Step 1: Write the schemas**

Create `plugins/plannen-kitchen/mcp/src/tools.ts`:

```ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const TOOLS: Tool[] = [
  // ── Stores ──────────────────────────────────────────────────────────────────
  {
    name: 'add_store',
    description: 'Add a store where you shop (e.g. "Carrefour Vilvoorde" / supermarket, "Bakker Pieters" / bakery).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Store name as you refer to it' },
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
        notes: { type: 'string' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'list_stores',
    description: 'List configured stores, alphabetical. Filter by type if you want only supermarkets, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
      },
    },
  },
  {
    name: 'update_store',
    description: 'Update a store name, type, or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
        notes: { type: 'string' },
      },
      required: ['store_id'],
    },
  },
  {
    name: 'delete_store',
    description: 'Delete a store. Items previously assigned to it keep their other fields; store_id is set to NULL.',
    inputSchema: {
      type: 'object',
      properties: { store_id: { type: 'string' } },
      required: ['store_id'],
    },
  },

  // ── Lists ───────────────────────────────────────────────────────────────────
  {
    name: 'create_list',
    description: 'Create a new shopping list (typically a weekly one). week_of is ISO date of the week start (Monday).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Week of 2026-05-14"' },
        week_of: { type: 'string', description: 'ISO date (yyyy-mm-dd) for the Monday of the week' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_lists',
    description: 'Recent shopping lists, newest first. Default limit 10. Response includes item_count and picked_count per list. Sets truncated:true when more results exist.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        limit: { type: 'number', description: 'Default 10' },
      },
    },
  },
  {
    name: 'update_list',
    description: 'Edit a list name, status (e.g. mark completed), or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        notes: { type: 'string' },
      },
      required: ['list_id'],
    },
  },

  // ── Items ───────────────────────────────────────────────────────────────────
  {
    name: 'add_item',
    description: 'Add one item to a list. Call this repeatedly when parsing a pasted list — once per item.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string', description: 'Item as written (multilingual ok)' },
        qty: { type: 'string', description: 'Free-text quantity ("2 kg", "1 packet", "few")' },
        store_id: { type: 'string', description: 'Optional. Use get_item_history first to find the usual store.' },
        aisle: { type: 'string', description: 'Free-text aisle ("dairy", "aisle 3")' },
        notes: { type: 'string' },
      },
      required: ['list_id', 'name'],
    },
  },
  {
    name: 'list_items',
    description: 'Items on a list, sorted by aisle then name. Response includes store_name when assigned.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'picked', 'skipped'] },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_item',
    description: 'Edit name, qty, store, aisle, or notes on an item. Pass null to clear store_id / aisle / notes.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        name: { type: 'string' },
        qty: { type: 'string' },
        store_id: { type: ['string', 'null'] },
        aisle: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'check_off_item',
    description: 'Mark an item picked. Sets status=picked and picked_at=now. The pantry view picks it up automatically.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Remove an item from a list entirely.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },

  // ── Pantry + history ────────────────────────────────────────────────────────
  {
    name: 'list_pantry',
    description: 'Items bought (picked) in the last N days, newest first. Default days=14.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days. Default 14, max 365.' },
      },
    },
  },
  {
    name: 'get_item_history',
    description: 'Last N times this item (case-insensitive name match) was picked. Returns store, aisle, list, date. Use to pre-fill store/aisle when adding to a new list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        limit: { type: 'number', description: 'Default 5' },
      },
      required: ['name'],
    },
  },
]
```

- [ ] **Step 2: Type-check**

```bash
cd plugins/plannen-kitchen/mcp && npx tsc --noEmit
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/tools.ts
git commit -m "kitchen-mcp: tool schema definitions"
```

---

## Task 10: MCP server entry (index.ts)

Wire everything together: load tools, dispatch handlers, connect stdio transport.

**Files:**
- Create: `plugins/plannen-kitchen/mcp/src/index.ts`

- [ ] **Step 1: Write the entry file**

Create `plugins/plannen-kitchen/mcp/src/index.ts`:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS } from './tools.js'
import { addStore, listStores, updateStore, deleteStore } from './stores.js'
import { createList, listLists, updateList } from './lists.js'
import { addItem, listItems, updateItem, checkOffItem, deleteItem } from './items.js'
import { listPantry, getItemHistory } from './pantry.js'

const server = new Server(
  { name: 'plannen-kitchen', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    let result: unknown
    switch (name) {
      case 'add_store':        result = await addStore(args as Parameters<typeof addStore>[0]); break
      case 'list_stores':      result = await listStores(args as Parameters<typeof listStores>[0]); break
      case 'update_store':     result = await updateStore(args as Parameters<typeof updateStore>[0]); break
      case 'delete_store':     result = await deleteStore(args as Parameters<typeof deleteStore>[0]); break
      case 'create_list':      result = await createList(args as Parameters<typeof createList>[0]); break
      case 'list_lists':       result = await listLists(args as Parameters<typeof listLists>[0]); break
      case 'update_list':      result = await updateList(args as Parameters<typeof updateList>[0]); break
      case 'add_item':         result = await addItem(args as Parameters<typeof addItem>[0]); break
      case 'list_items':       result = await listItems(args as Parameters<typeof listItems>[0]); break
      case 'update_item':      result = await updateItem(args as Parameters<typeof updateItem>[0]); break
      case 'check_off_item':   result = await checkOffItem(args as Parameters<typeof checkOffItem>[0]); break
      case 'delete_item':      result = await deleteItem(args as Parameters<typeof deleteItem>[0]); break
      case 'list_pantry':      result = await listPantry(args as Parameters<typeof listPantry>[0]); break
      case 'get_item_history': result = await getItemHistory(args as Parameters<typeof getItemHistory>[0]); break
      default: throw new Error(`Unknown tool: ${name}`)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[plannen-kitchen-mcp] ready\n')
```

- [ ] **Step 2: Build the MCP**

```bash
cd plugins/plannen-kitchen/mcp && npm run build
```

Expected: `dist/index.js`, `dist/client.js`, `dist/helpers.js`, `dist/items.js`, `dist/lists.js`, `dist/pantry.js`, `dist/stores.js`, `dist/tools.js` all present, no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd plugins/plannen-kitchen/mcp && npm test
```

Expected: helpers tests all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/plannen-kitchen/mcp/src/index.ts
git commit -m "kitchen-mcp: server entry with tool dispatch"
```

---

## Task 11: Plugin manifest

Register the kitchen MCP server under the plugin.

**Files:**
- Create: `plugins/plannen-kitchen/.claude-plugin/plugin.json`

- [ ] **Step 1: Write the manifest**

Create `plugins/plannen-kitchen/.claude-plugin/plugin.json`:

```json
{
  "name": "plannen-kitchen",
  "version": "0.1.0",
  "description": "Weekly grocery, pantry, and meal-plan reasoning for Plannen. Adds the kitchen.* schema, an MCP server, three skills (kitchen-shop, kitchen-pantry, kitchen-meal-plan), and a mobile-first in-store check-off page.",
  "author": {
    "name": "Pari",
    "url": "https://github.com/pariksheet/plannen"
  },
  "homepage": "https://github.com/pariksheet/plannen",
  "license": "AGPL-3.0-only",
  "mcpServers": {
    "plannen-kitchen": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/index.js"]
    }
  }
}
```

Note: `${CLAUDE_PLUGIN_ROOT}` expands to `plugins/plannen-kitchen/` (the directory containing `.claude-plugin/`). The Plannen plugin uses `../mcp/dist/index.js` because its MCP sits one level above; here, the MCP lives inside the plugin so the path has no `../`.

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/.claude-plugin/plugin.json
git commit -m "kitchen: plugin manifest"
```

---

## Task 12: Skill — kitchen-shop

The skill Claude loads when the user starts a shopping flow. Tells Claude how to parse a pasted list, look up history, and add items.

**Files:**
- Create: `plugins/plannen-kitchen/skills/kitchen-shop.md`

- [ ] **Step 1: Write the skill**

Create `plugins/plannen-kitchen/skills/kitchen-shop.md`:

```markdown
---
name: kitchen-shop
description: Use when the user pastes a shopping list (WhatsApp text, photo of a handwritten list, dictation), asks to add items to this week's list, asks where they bought something last, or invokes /kitchen-list. Drives the kitchen MCP tools to create a list and add items with store/aisle inferred from history.
---

# Kitchen — shopping flow

You are the shopping helper for plannen-kitchen. The user gets a weekly grocery list from his wife (usually via WhatsApp), splits items across a primary supermarket plus a bakery and a local shop, and wants minimal in-store backtracking.

## When the user pastes a list

1. **Find or create the active list.** Call `list_lists(status='active', limit=5)`. If one matches the current week, reuse it. Otherwise call `create_list(name='Week of <Monday yyyy-mm-dd>', week_of='<Monday yyyy-mm-dd>')` where Monday is the most recent Monday on or before today.

2. **Parse items yourself.** Read the pasted text (or OCR the image). Handle:
   - Mixed languages (English, Marathi, Dutch). Keep the original spelling — don't translate.
   - Quantities embedded in text ("milk 2L", "2 kg paneer"). Split into `name` and `qty`.
   - Abbreviations ("veg" → leave as "veg", let the user clarify if relevant).

3. **Look up history per item.** Call `get_item_history(name)` once per item. If results exist, use the most recent `store_id` and `aisle` as defaults when calling `add_item`. If no history, leave `store_id` / `aisle` null — the user can fill in during the first shop.

4. **Add items.** Call `add_item(list_id, name, qty?, store_id?, aisle?)` once per item.

5. **Summarise back.** Tell the user how many items got added, broken down by store (e.g. "Added 18 items: 13 supermarket, 2 bakery, 3 local, 0 unassigned"). Mention any items where history was ambiguous so they can correct.

## When the user asks "where did I buy X?"

Call `get_item_history(name)`. Tell them the most recent store and aisle. If multiple stores in history, mention that and which one was most recent.

## When the user adds a one-off item

If they say "also add cumin to this week's list", find the active list (`list_lists(status='active', limit=1)`), then `get_item_history('cumin')` + `add_item(...)`. Same flow as bulk add, just for one row.

## When the user wants the in-store view

Tell them: "Open http://localhost:4321/kitchen on your phone. Tap items as you pick them up."

This is also the destination of the `/kitchen-shop` slash command.

## Stores not yet configured

If `list_stores()` returns empty (or doesn't include the store you'd naturally infer), ask the user to add it: "I don't see [store name] yet — should I create it as a supermarket / bakery / local / online / other?" Then call `add_store(name, type)`.

## Multilingual matching

`get_item_history` uses case-insensitive exact match. If the user wrote "dudh" once and "milk" another time, history won't unify them. Don't auto-merge — if you're unsure whether two names refer to the same thing, ask once and learn.

## Boundaries

- Don't suggest meals here. That's `kitchen-meal-plan`'s job.
- Don't tell the user what to buy — the list comes from them. You just structure it.
- Never call `delete_item` without confirmation — the user wrote the list, deletion is their call.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/skills/kitchen-shop.md
git commit -m "kitchen: kitchen-shop skill"
```

---

## Task 13: Skill — kitchen-pantry

Tells Claude how to answer pantry questions.

**Files:**
- Create: `plugins/plannen-kitchen/skills/kitchen-pantry.md`

- [ ] **Step 1: Write the skill**

Create `plugins/plannen-kitchen/skills/kitchen-pantry.md`:

```markdown
---
name: kitchen-pantry
description: Use when the user asks what's in the pantry, what they bought recently, what's still around from last week's shop, or any "do I have X?" question. Reads kitchen.pantry via list_pantry.
---

# Kitchen — pantry queries

The pantry is a derived view over recently-picked items in `kitchen.items`. There is no separate inventory table — `list_pantry(days)` returns items picked within the last N days.

## "What's in the pantry?"

1. Call `list_pantry(days=14)` by default. Tighten to `days=7` if the user asks about the current week specifically; widen to `days=30` if they ask about "this month".
2. Group results by `store_name` for readability (most users think "what's in the fridge" rather than "what came from Carrefour", but grouping by store helps when they want to verify a particular shop).
3. Mention items more than ~5 days old explicitly — they may have been consumed already (we don't track consumption).

## "Do we still have X?"

1. Call `list_pantry(days=14)` and scan for the item name (case-insensitive).
2. If found: report when it was bought ("you picked up milk 2 days ago").
3. If not found: say so plainly. Don't speculate about whether they ate it — just report what the data shows.

## Caveats to surface

Pantry is "what you bought" not "what you have." If the user is making a decision based on it, mention this once at the start of the conversation so they know to verify perishables themselves. Don't repeat the caveat every message.

## When to suggest writing it back

If the user finds an error ("I never bought that paneer"), they probably tapped wrong in the UI. Offer to undo: call `update_item(item_id, status='pending')` (which, in v1, is via passing status through update_item — if `update_item` doesn't expose status, just leave it and tell the user to ignore the item).

## Boundaries

- Pantry queries are read-only. Don't add or remove items in this flow.
- Meal planning is `kitchen-meal-plan`, not here. If the user pivots from "what do we have" to "what should we cook", switch skills.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/skills/kitchen-pantry.md
git commit -m "kitchen: kitchen-pantry skill"
```

---

## Task 14: Skill — kitchen-meal-plan

The skill that uses the Plannen calendar to inform meal planning.

**Files:**
- Create: `plugins/plannen-kitchen/skills/kitchen-meal-plan.md`

- [ ] **Step 1: Write the skill**

Create `plugins/plannen-kitchen/skills/kitchen-meal-plan.md`:

```markdown
---
name: kitchen-meal-plan
description: Use when the user asks to plan meals for the week, suggest dinners, decide what to cook, or asks any forward-looking question about meals. Combines kitchen.pantry contents with the Plannen calendar (school days, trips, parties) to suggest meals.
---

# Kitchen — meal-plan reasoning

There is no `suggest_meals` MCP tool. Meal planning is **your** reasoning over two data sources:

1. **Pantry:** call `list_pantry(days=14)` — what's recently bought.
2. **Calendar:** call `mcp__plannen__list_events(from_date=<today>, to_date=<today+7d>, limit=50)` — school days, trips, parties, anything that affects whether a meal needs to be cooked at home.

The `limit=50` is important: Plannen's `list_events` defaults to 10 and silently truncates. Always set 50 or higher for any week-or-longer planning question.

## The reasoning pattern

For a "plan dinners this week" request:

1. Determine which days need cooked meals at home. Skip days where an event implies "not eating at home" (e.g. a party from 7pm onward, a trip starting that day, a planned restaurant outing).
2. List the pantry items grouped by category in your head (proteins, vegetables, staples).
3. Suggest one meal per cooked-at-home day. Each meal should use at least one pantry item. Prefer meals that use multiple to reduce waste.
4. Note any gaps: ingredients the user needs to buy to complete suggested meals. Offer to add them to the active list (via the `kitchen-shop` skill — `list_lists(status='active', limit=1)` then `add_item`).

## Family context

The user's family (call `mcp__plannen__list_family_members()` if you don't already have it cached this session) likely includes kids in school. School days = lunchbox prep. School holidays = lunch at home. Factor that in when the user asks about lunches not just dinners.

## Output shape

Concise table or bullet list:

```
Mon: palak paneer (uses spinach + paneer from pantry)
Tue: rice + dal (staples only — no shopping needed)
Wed: skip — Sofie's birthday dinner
Thu: chicken curry (need: chicken, onions; rest in pantry)
Fri–Sun: trip to Pune — skip
```

Then a single line: "Add chicken + onions to this week's list?"

## What NOT to do

- Don't propose meals that ignore the calendar. If Wed is a party, don't suggest a Wed dinner.
- Don't make up pantry items. Only suggest what came back from `list_pantry`.
- Don't add ingredients to the list without explicit consent. Always confirm first.
- Don't store the meal plan anywhere. It's ephemeral — re-derive it each time.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/skills/kitchen-meal-plan.md
git commit -m "kitchen: kitchen-meal-plan skill"
```

---

## Task 15: Commands — /kitchen-list and /kitchen-shop

Two slash commands. `/kitchen-list` is a paste-and-parse helper; `/kitchen-shop` opens the in-store view.

**Files:**
- Create: `plugins/plannen-kitchen/commands/kitchen-list.md`
- Create: `plugins/plannen-kitchen/commands/kitchen-shop.md`

- [ ] **Step 1: Write /kitchen-list**

Create `plugins/plannen-kitchen/commands/kitchen-list.md`:

```markdown
---
description: Paste this week's grocery list (text or image) and have Claude parse it into the kitchen.lists / kitchen.items tables.
argument-hint: "[paste list contents]"
---

The user has invoked `/kitchen-list`. Trigger the `kitchen-shop` skill.

If the user attached the list content as an argument, parse it immediately following the "When the user pastes a list" flow in `kitchen-shop`. If no content is attached, ask: *"Paste the list (text or an image of the handwritten list) and I'll add it to this week's list."*
```

- [ ] **Step 2: Write /kitchen-shop**

Create `plugins/plannen-kitchen/commands/kitchen-shop.md`:

```markdown
---
description: Open the in-store mobile check-off view at localhost:4321/kitchen.
argument-hint: ""
---

The user has invoked `/kitchen-shop`. Reply with exactly:

> Open **http://localhost:4321/kitchen** on your phone (same wifi). Items are grouped by store and sorted by aisle within each store. Tap to check off as you pick up.

Do not call any MCP tools.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/commands/kitchen-list.md plugins/plannen-kitchen/commands/kitchen-shop.md
git commit -m "kitchen: /kitchen-list and /kitchen-shop commands"
```

---

## Task 16: Plannen web app — plugin slot

Add a generic `src/plugins/` directory that the Plannen web app scans via `import.meta.glob`. Each file dropped into the directory contributes one route + one nav item. Plannen core has zero kitchen-specific code.

**Files:**
- Create: `src/plugins/index.ts`
- Create: `src/plugins/.gitkeep`
- Modify: `src/routes/AppRoutes.tsx`

- [ ] **Step 1: Identify the nav file**

```bash
grep -rln "Dashboard\|Stories\|Family" src/components/ src/pages/ | head -10
```

Pick the navigation/sidebar file the result reveals (likely `src/components/Sidebar.tsx`, `src/components/Nav.tsx`, or rendered inline in `src/pages/Dashboard.tsx`). If multiple candidates, the one that contains `<Link to="/dashboard">` or similar route-aware children is the right one. Note its path — you'll modify it in Step 5.

- [ ] **Step 2: Write `src/plugins/index.ts`**

Create `src/plugins/index.ts`:

```ts
import type { ComponentType } from 'react'

export type PluginEntry = {
  /** Display label shown in the nav. */
  label: string
  /** Mount path (e.g. "/kitchen"). Must start with "/" and be unique. */
  route: string
  /** Component rendered when the route is active. */
  Component: ComponentType
}

// Vite glob: eagerly import every .tsx file dropped into this directory.
// Plugins are expected to symlink a single .tsx file in here via their
// install.sh. Each file must default-export a PluginEntry.
const modules = import.meta.glob<{ default: PluginEntry }>('./*.tsx', { eager: true })

export const plugins: PluginEntry[] = Object.values(modules)
  .map(m => m.default)
  .filter((p): p is PluginEntry => Boolean(p && p.route && p.label && p.Component))
  .sort((a, b) => a.label.localeCompare(b.label))
```

- [ ] **Step 3: Add `.gitkeep` so the empty directory is tracked**

Create `src/plugins/.gitkeep`:

```
# Plugin UI slot.
# Plugins drop a single .tsx file here via their install.sh.
# This file keeps the directory tracked even when no plugins are installed.
```

- [ ] **Step 4: Modify `src/routes/AppRoutes.tsx` to iterate plugins**

Read the current `AppRoutes.tsx`, then add the import and route mapping. The import goes near the existing imports:

```ts
import { plugins } from '../plugins'
```

Inside the `<Routes>` JSX block, after the existing protected routes (e.g. after the `/profile` route — pick the spot just before the catch-all `/` redirect), insert:

```tsx
{plugins.map(plugin => (
  <Route
    key={plugin.route}
    path={plugin.route}
    element={
      <ProtectedRoute>
        <plugin.Component />
      </ProtectedRoute>
    }
  />
))}
```

- [ ] **Step 5: Modify the nav file to iterate plugins**

In the nav file you identified in Step 1, after the last hardcoded nav entry, insert (adapt to its component shape):

```tsx
import { plugins } from '../plugins'

// ... inside the nav's JSX, after the last hardcoded item:
{plugins.map(plugin => (
  <NavLink key={plugin.route} to={plugin.route}>
    {plugin.label}
  </NavLink>
))}
```

If the nav uses a different component than `NavLink` (e.g. raw `<Link>`, a custom `<NavItem>`, or a buttoned tab), use the same component the existing nav entries use. The point is one entry per plugin, with the plugin's label and route.

- [ ] **Step 6: Verify the slot works empty**

```bash
npm run dev
```

Expected: app loads at http://localhost:4321 without errors. No new nav items (slot is empty). Open the browser console — no glob errors.

Hit `Ctrl+C` to stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/plugins/index.ts src/plugins/.gitkeep src/routes/AppRoutes.tsx <nav-file-path>
git commit -m "web: generic plugin slot in src/plugins/"
```

---

## Task 17: Kitchen web Supabase client

Schema-scoped Supabase client for the kitchen UI. Same pattern as `src/lib/supabase.ts` but with `db: { schema: 'kitchen' }`.

**Files:**
- Create: `plugins/plannen-kitchen/web/supabase.ts`

- [ ] **Step 1: Write the client**

Create `plugins/plannen-kitchen/web/supabase.ts`:

```ts
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  const msg = 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Run bootstrap.sh first.'
  console.error(msg)
  throw new Error(msg)
}

export const kitchenDb = createClient(url, anonKey, {
  db: { schema: 'kitchen' },
})
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/web/supabase.ts
git commit -m "kitchen-web: schema-scoped Supabase client"
```

---

## Task 18: ShopView component

The single page for v1: the mobile-first in-store check-off view.

**Files:**
- Create: `plugins/plannen-kitchen/web/ShopView.tsx`

- [ ] **Step 1: Write the component**

Create `plugins/plannen-kitchen/web/ShopView.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { kitchenDb } from './supabase'

type Item = {
  id: string
  name: string
  qty: string | null
  store_id: string | null
  store_name: string | null
  store_type: string | null
  aisle: string | null
  status: 'pending' | 'picked' | 'skipped'
  picked_at: string | null
}

type List = {
  id: string
  name: string
  week_of: string | null
  status: 'active' | 'completed' | 'archived'
}

async function fetchActiveList(): Promise<List | null> {
  const { data, error } = await kitchenDb
    .from('lists')
    .select('id, name, week_of, status')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error(error)
    return null
  }
  return data as List | null
}

async function fetchItems(listId: string): Promise<Item[]> {
  const { data, error } = await kitchenDb
    .from('items')
    .select(`
      id, name, qty, store_id, aisle, status, picked_at,
      stores ( name, type )
    `)
    .eq('list_id', listId)
    .order('status', { ascending: true })       // pending first
    .order('aisle', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) {
    console.error(error)
    return []
  }
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    qty: row.qty,
    store_id: row.store_id,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    aisle: row.aisle,
    status: row.status,
    picked_at: row.picked_at,
  }))
}

async function toggleItem(itemId: string, currentStatus: Item['status']): Promise<void> {
  const next = currentStatus === 'picked'
    ? { status: 'pending' as const, picked_at: null }
    : { status: 'picked' as const, picked_at: new Date().toISOString() }
  const { error } = await kitchenDb.from('items').update(next).eq('id', itemId)
  if (error) {
    console.error(error)
    throw error
  }
}

function groupByStore(items: Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>()
  for (const item of items) {
    const key = item.store_name ?? 'Unassigned'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  return groups
}

export default function ShopView() {
  const [list, setList] = useState<List | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const active = await fetchActiveList()
      if (cancelled) return
      setList(active)
      if (active) {
        const rows = await fetchItems(active.id)
        if (!cancelled) setItems(rows)
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>
  if (!list) {
    return (
      <div className="p-6 text-gray-700">
        <h1 className="text-lg font-semibold mb-2">No active shopping list</h1>
        <p className="text-sm">Ask Claude to start one: paste this week's WhatsApp list into the chat and Claude will populate it. Then come back here to check off.</p>
      </div>
    )
  }

  const picked = items.filter(i => i.status === 'picked').length
  const total = items.length
  const grouped = groupByStore(items)

  async function handleToggle(item: Item) {
    // optimistic update
    const next: Item['status'] = item.status === 'picked' ? 'pending' : 'picked'
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: next, picked_at: next === 'picked' ? new Date().toISOString() : null } : i))
    try {
      await toggleItem(item.id, item.status)
    } catch {
      // rollback
      setItems(prev => prev.map(i => i.id === item.id ? item : i))
    }
  }

  return (
    <div className="max-w-md mx-auto pb-12">
      <header className="sticky top-0 bg-white border-b px-4 py-3 flex justify-between items-center">
        <div>
          <h1 className="text-base font-semibold">{list.name}</h1>
          {list.week_of && <div className="text-xs text-gray-500">week of {list.week_of}</div>}
        </div>
        <div className="text-sm font-mono">{picked} / {total}</div>
      </header>

      {[...grouped.entries()].map(([storeName, storeItems]) => {
        const remaining = storeItems.filter(i => i.status !== 'picked').length
        return (
          <section key={storeName} className="border-b">
            <h2 className="px-4 py-2 text-sm font-medium bg-gray-50 flex justify-between">
              <span>{storeName}</span>
              <span className="text-gray-500">{remaining} left</span>
            </h2>
            <ul>
              {storeItems.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleToggle(item)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 active:bg-gray-100 ${
                      item.status === 'picked' ? 'text-gray-400 line-through' : ''
                    }`}
                  >
                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-xs ${
                      item.status === 'picked' ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300'
                    }`}>
                      {item.status === 'picked' ? '✓' : ''}
                    </span>
                    <span className="flex-1">
                      <span className="block">{item.name}{item.qty ? ` · ${item.qty}` : ''}</span>
                      {item.aisle && <span className="block text-xs text-gray-500">aisle: {item.aisle}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: clean compile (the file isn't yet linked into the build, but TS should still parse it). If TS complains about `import.meta.env`, that's because the file isn't yet under the Vite project — it'll resolve once the symlink is in place (Task 20). For now, also try compiling from inside the project context:

```bash
npx tsc --noEmit plugins/plannen-kitchen/web/ShopView.tsx --jsx react-jsx --moduleResolution node --esModuleInterop
```

The component should compile. Tailwind classes are unverified at this point (they'll render through the main app's Tailwind config once mounted).

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/web/ShopView.tsx
git commit -m "kitchen-web: ShopView component (mobile-first in-store view)"
```

---

## Task 19: kitchen.tsx entry export

The default-export wrapper that `src/plugins/index.ts` consumes. Exports a `PluginEntry` shape.

**Files:**
- Create: `plugins/plannen-kitchen/web/kitchen.tsx`

- [ ] **Step 1: Write the entry**

Create `plugins/plannen-kitchen/web/kitchen.tsx`:

```tsx
import ShopView from './ShopView'

const entry = {
  label: 'Kitchen',
  route: '/kitchen',
  Component: ShopView,
}

export default entry
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/web/kitchen.tsx
git commit -m "kitchen-web: plugin entry export"
```

---

## Task 20: install.sh

Plugin installer that wires everything up: builds the MCP, symlinks migrations into Plannen's migration folder, symlinks the UI into Plannen's plugin slot, and registers the plugin + MCP with Claude Code.

**Files:**
- Create: `plugins/plannen-kitchen/install.sh`

- [ ] **Step 1: Write the install script**

Create `plugins/plannen-kitchen/install.sh`:

```bash
#!/usr/bin/env bash
# plannen-kitchen — installer.
#
# Run from repo root: bash plugins/plannen-kitchen/install.sh
# Or via bootstrap: bash scripts/bootstrap.sh --plugin plannen-kitchen

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

step()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

cd "$REPO_ROOT"

# ── 1. Build the MCP server ──────────────────────────────────────────────────
step "Building plannen-kitchen MCP"
(cd "$PLUGIN_DIR/mcp" && npm install --silent && npm run build --silent)
ok "MCP built at $PLUGIN_DIR/mcp/dist/index.js"

# ── 2. Symlink migrations into Plannen's supabase/migrations ─────────────────
step "Linking kitchen migrations into supabase/migrations"
for src in "$PLUGIN_DIR/supabase/migrations/"*.sql; do
  [ -e "$src" ] || continue
  base="$(basename "$src")"
  link="$REPO_ROOT/supabase/migrations/$base"
  if [ -L "$link" ]; then
    ok "  $base already linked"
  elif [ -e "$link" ]; then
    err "  $base exists in supabase/migrations/ but is not a symlink — refusing to overwrite"
    exit 1
  else
    ln -s "$src" "$link"
    ok "  linked $base"
  fi
done

# ── 3. Run migrations ────────────────────────────────────────────────────────
step "Applying migrations (supabase migration up)"
if supabase status >/dev/null 2>&1; then
  supabase migration up
  ok "Migrations applied"
else
  warn "supabase not running — start it (supabase start) then re-run this script"
fi

# ── 4. Symlink the web UI into src/plugins/ ──────────────────────────────────
step "Linking kitchen UI into src/plugins/"
link="$REPO_ROOT/src/plugins/kitchen.tsx"
src="$PLUGIN_DIR/web/kitchen.tsx"
if [ -L "$link" ]; then
  ok "  kitchen.tsx already linked"
elif [ -e "$link" ]; then
  err "  src/plugins/kitchen.tsx exists but is not a symlink — refusing to overwrite"
  exit 1
else
  ln -s "$src" "$link"
  ok "  linked kitchen.tsx"
fi

# ── 5. Register the plugin with Claude Code ──────────────────────────────────
step "Registering plugin with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude plugin install "$PLUGIN_DIR" || warn "claude plugin install failed — install manually with: /plugin install $PLUGIN_DIR"
  ok "Plugin registered"
else
  warn "claude CLI not on PATH — install manually with: /plugin install $PLUGIN_DIR"
fi

# ── 6. Done ──────────────────────────────────────────────────────────────────
cat <<EOF

\033[1;32m✓\033[0m plannen-kitchen installed.

Next:
  • Restart Claude Code (so the new plugin + MCP load)
  • Open http://localhost:4321/kitchen on your phone (same wifi)
  • Or type /kitchen-list and paste this week's grocery list

EOF
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x plugins/plannen-kitchen/install.sh
```

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/install.sh
git commit -m "kitchen: install script"
```

---

## Task 21: uninstall.sh

Symmetric remover. Drops the schema only if `--drop-schema` is passed.

**Files:**
- Create: `plugins/plannen-kitchen/uninstall.sh`

- [ ] **Step 1: Write the uninstall script**

Create `plugins/plannen-kitchen/uninstall.sh`:

```bash
#!/usr/bin/env bash
# plannen-kitchen — uninstaller.
#
# Usage:
#   bash plugins/plannen-kitchen/uninstall.sh
#   bash plugins/plannen-kitchen/uninstall.sh --drop-schema   # also drops kitchen.* tables

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

DROP_SCHEMA=0
for arg in "$@"; do
  case "$arg" in
    --drop-schema) DROP_SCHEMA=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

step()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }

cd "$REPO_ROOT"

# ── 1. Unregister plugin from Claude Code ────────────────────────────────────
step "Unregistering plugin from Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude plugin uninstall plannen-kitchen || warn "claude plugin uninstall failed (may not be registered)"
  ok "Plugin unregistered"
fi

# ── 2. Remove web UI symlink ─────────────────────────────────────────────────
step "Removing UI symlink"
link="$REPO_ROOT/src/plugins/kitchen.tsx"
if [ -L "$link" ]; then
  rm "$link"
  ok "Removed src/plugins/kitchen.tsx"
elif [ -e "$link" ]; then
  warn "src/plugins/kitchen.tsx exists but isn't a symlink — left in place"
else
  ok "No UI symlink to remove"
fi

# ── 3. Remove migration symlinks ─────────────────────────────────────────────
step "Removing migration symlinks"
for src in "$PLUGIN_DIR/supabase/migrations/"*.sql; do
  [ -e "$src" ] || continue
  base="$(basename "$src")"
  link="$REPO_ROOT/supabase/migrations/$base"
  if [ -L "$link" ]; then
    rm "$link"
    ok "  removed $base"
  fi
done

# ── 4. Optionally drop the schema ────────────────────────────────────────────
if [ "$DROP_SCHEMA" -eq 1 ]; then
  step "Dropping kitchen schema (--drop-schema)"
  if supabase status >/dev/null 2>&1; then
    psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "DROP SCHEMA IF EXISTS kitchen CASCADE;"
    ok "Schema dropped"
  else
    warn "supabase not running — start it and run: psql ... -c 'DROP SCHEMA kitchen CASCADE;'"
  fi
else
  warn "Schema kitchen.* left intact. Re-run with --drop-schema to drop it."
fi

ok "plannen-kitchen uninstalled."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x plugins/plannen-kitchen/uninstall.sh
```

- [ ] **Step 3: Commit**

```bash
git add plugins/plannen-kitchen/uninstall.sh
git commit -m "kitchen: uninstall script (with optional --drop-schema)"
```

---

## Task 22: bootstrap.sh — add --plugin flag

Extend the existing bootstrap script with a `--plugin <name>` flag that, after core setup, runs the named plugin's installer (or every plugin if `--plugin all`).

**Files:**
- Modify: `scripts/bootstrap.sh`

- [ ] **Step 1: Find the existing argument-parsing block**

```bash
grep -n "while \[ \$# -gt 0 \]" scripts/bootstrap.sh
```

Note the line number — that's where the `--plugin` case goes.

- [ ] **Step 2: Add the flag declaration above the parsing loop**

In the variable initialisation block (near `NON_INTERACTIVE=0` etc.), add:

```bash
PLUGIN_NAMES=()
```

- [ ] **Step 3: Add the case in the parsing loop**

Inside the existing `case "$1" in` block, before the `-h|--help)` case, add:

```bash
    --plugin) PLUGIN_NAMES+=("$2"); shift 2 ;;
    --plugin=*) PLUGIN_NAMES+=("${1#--plugin=}"); shift ;;
```

- [ ] **Step 4: Add the install loop near the end of the script**

After the existing setup steps (after `--start-dev` handling, or at the end if there's no clear "last step" marker), add:

```bash
# ── Step N: Install requested plugins ─────────────────────────────────────────
if [ ${#PLUGIN_NAMES[@]} -gt 0 ]; then
  for plugin_name in "${PLUGIN_NAMES[@]}"; do
    if [ "$plugin_name" = "all" ]; then
      for plugin_dir in plugins/*/; do
        if [ -x "${plugin_dir}install.sh" ]; then
          step "Installing plugin: $(basename "$plugin_dir")"
          bash "${plugin_dir}install.sh" || err "Plugin install failed: $plugin_dir"
        fi
      done
    else
      plugin_dir="plugins/$plugin_name"
      if [ ! -d "$plugin_dir" ]; then
        err "Unknown plugin: $plugin_name (expected plugins/$plugin_name/ to exist)"
        exit 1
      fi
      if [ ! -x "$plugin_dir/install.sh" ]; then
        err "Plugin $plugin_name has no executable install.sh"
        exit 1
      fi
      step "Installing plugin: $plugin_name"
      bash "$plugin_dir/install.sh" || err "Plugin install failed: $plugin_name"
    fi
  done
fi
```

- [ ] **Step 5: Test bootstrap with no plugin (should work as before)**

```bash
bash scripts/bootstrap.sh --help
```

Expected: help text shows usage (may or may not mention `--plugin` depending on whether you also updated the help block — optional).

- [ ] **Step 6: Commit**

```bash
git add scripts/bootstrap.sh
git commit -m "bootstrap: --plugin flag for opt-in plugin installs"
```

---

## Task 23: README for the kitchen plugin

User-facing readme. Explains what it does, how to install, what's in v1.

**Files:**
- Create: `plugins/plannen-kitchen/README.md`

- [ ] **Step 1: Write the README**

Create `plugins/plannen-kitchen/README.md`:

```markdown
# plannen-kitchen

Weekly grocery, pantry, and meal-plan reasoning for [Plannen](../..).

A sibling Claude Code plugin that lives alongside the main Plannen plugin. Adds a `kitchen.*` schema, an MCP server, three skills, two slash commands, and one mobile-first web page.

## What it does

- **Parse a grocery list** pasted from WhatsApp text or an image of a handwritten list. Claude reads it, looks up where you usually buy each item, and structures it into a weekly list with store + aisle tags.
- **Check off items in-store** on your phone at `localhost:4321/kitchen`. Grouped by store; sorted by aisle. No more backtracking through the supermarket.
- **Pantry awareness.** Items you check off feed a `pantry` view (everything bought in the last 14 days). Ask Claude "what's in the pantry?" and you'll know.
- **Meal-plan reasoning** that consumes both the pantry and your Plannen calendar (school days, parties, trips), so suggestions skip days you're not eating at home and use ingredients you already bought.

## Install

From the repo root, after `bootstrap.sh` has set up the core Plannen app:

```bash
bash plugins/plannen-kitchen/install.sh
```

Or as part of bootstrap:

```bash
bash scripts/bootstrap.sh --plugin plannen-kitchen
```

The installer:
1. Builds the kitchen MCP server.
2. Symlinks the kitchen migrations into `supabase/migrations/`.
3. Runs `supabase migration up` (if Supabase is running).
4. Symlinks the kitchen UI into `src/plugins/kitchen.tsx`.
5. Registers the plugin with Claude Code.

Restart Claude Code afterwards so the new plugin loads.

## Usage

- `/kitchen-list` — paste this week's list (text or image). Claude parses + structures + populates this week's list.
- `/kitchen-shop` — opens (well, prints the URL for) the in-store page.
- Conversational: "what's in the pantry?", "plan dinners this week", "where did I buy paneer last time?"

## Uninstall

```bash
bash plugins/plannen-kitchen/uninstall.sh
```

Add `--drop-schema` if you want to drop `kitchen.*` and lose all data. Without that flag, the schema is preserved so reinstall keeps your history.

## Architecture

See `docs/superpowers/specs/2026-05-14-plannen-kitchen-plugin-design.md` in the parent repo for the full design.

## License

AGPL-3.0-only, same as Plannen.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/plannen-kitchen/README.md
git commit -m "kitchen: README"
```

---

## Task 24: End-to-end smoke test

Verify the whole thing works on a real local Supabase. This is the only "test" for the DB-touching tools — they're not unit-tested by design (project pattern).

**Files:** (no new files — verification only)

- [ ] **Step 1: Ensure Supabase is running**

```bash
supabase status
```

Expected: status shows running services. If not, run `supabase start` and wait for it to come up.

- [ ] **Step 2: Run the install script from a clean state**

If you've already installed during development, run the uninstaller first (without `--drop-schema` if you want to preserve test data, or with it for a clean slate):

```bash
bash plugins/plannen-kitchen/uninstall.sh --drop-schema
```

Then:

```bash
bash plugins/plannen-kitchen/install.sh
```

Expected output: each `▸` step ends with a `✓`. No `✗` errors. Final message: "plannen-kitchen installed."

- [ ] **Step 3: Verify schema exists**

```bash
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\dt kitchen.*"
```

Expected: 3 tables (stores, lists, items).

```bash
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\dv kitchen.*"
```

Expected: 1 view (pantry).

- [ ] **Step 4: Verify MCP server runs**

```bash
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2-) \
PLANNEN_USER_EMAIL=$(grep '^PLANNEN_USER_EMAIL=' .env | cut -d= -f2-) \
node plugins/plannen-kitchen/mcp/dist/index.js < /dev/null
```

Expected: process prints `[plannen-kitchen-mcp] ready` to stderr, then exits when stdin closes. No errors about missing env vars or unknown email.

- [ ] **Step 5: Restart Claude Code and verify plugin loads**

Restart Claude Code (close and reopen). In a new session:

1. Type `/help` and verify `/kitchen-list` and `/kitchen-shop` are listed.
2. Ask Claude: "create a test kitchen list called 'smoke test'". Claude should call `create_list` and confirm.
3. Ask Claude: "add 'milk 1L' and 'bread' to the smoke test list". Verify they're added.
4. Ask Claude: "list items on the smoke test list". Verify they come back.
5. Ask Claude: "mark milk as picked". Verify status flips.
6. Ask Claude: "what's in the pantry?". Verify milk shows up.
7. Open http://localhost:4321/kitchen in a browser. Verify the list renders with milk crossed out and bread pending. Tap bread to check it off; refresh; verify pantry now has both items.
8. Ask Claude: "where did I buy milk last time?". Verify it answers based on history.

If every step works: smoke test passes.

- [ ] **Step 6: Document any failures**

If anything in Step 5 didn't work, fix the issue and re-run. Common causes:
- MCP server didn't rebuild → `cd plugins/plannen-kitchen/mcp && npm run build` and restart Claude Code.
- Web app didn't pick up the symlink → restart `npm run dev`.
- Schema didn't apply → check `supabase status` and re-run `supabase migration up`.

- [ ] **Step 7: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "kitchen: smoke-test fixes" || true   # ok if no changes
```

---

## Spec coverage check

For each section of the spec, the task that implements it:

| Spec section | Implemented by |
|---|---|
| Goals: opt-in plugin, kitchen.* schema, MCP, skills, UI page | Tasks 1, 2–10, 11, 12–14, 17–19 |
| Non-goals (framework, two-user, consumption, recipes, …) | (Nothing built — intentional) |
| Architecture decisions table | Tasks 1, 2, 10, 11, 12–15, 16, 17–19, 20, 22 |
| Repository layout | Tasks 1–23 (every file in the layout has a creating task) |
| Data model (stores, lists, items, pantry view, indexes) | Task 1 |
| MCP tool surface (14 tools listed in spec) | Tasks 5 (4 store), 6 (3 list), 7 (5 item), 8 (2 pantry/history), 9 (schemas) = 14 tools |
| UI: plugin slot + ShopView | Tasks 16, 17, 18, 19 |
| Data flows (intake, in-store, pantry) | Tasks 12 (intake skill), 18 (in-store UI), 13 (pantry skill) |
| Install / uninstall | Tasks 20, 21 |
| Bootstrap.sh --plugin flag | Task 22 |
| Cross-plugin data access (kitchen skills call mcp__plannen__*) | Task 14 (kitchen-meal-plan calls mcp__plannen__list_events) |
| Open questions: item-name canonicalisation, list rollover, week_of semantics, mobile auth | (Deferred per spec; no tasks) |
| Backlog (templates, store-layout, consumption, …) | (Not in v1; no tasks) |
| Testing | Task 4 (unit) + Task 24 (smoke) |

All spec sections have a task or are intentionally deferred.

---

## Execution notes

- Tasks 1–10 are mostly sequential: schema first, then each MCP module, then the server entry. Tasks 5–8 (store/list/item/pantry handlers) could be parallelised across subagents since they don't depend on each other after Task 4 (helpers).
- Tasks 11–15 (manifest, skills, commands) are independent of each other and only depend on the rough shape of the MCP being known (Tasks 9–10).
- Tasks 16, 17, 18, 19 are sequential: slot first, then client, then component, then entry.
- Tasks 20–22 are sequential: install + uninstall first, then bootstrap glue that calls install.
- Task 24 must be last.

If executing with subagents, dispatch shape:
- Round 1: Task 1 (schema)
- Round 2: Tasks 2, 11, 12, 13, 14, 15, 23 in parallel (manifest + skills + commands + README — none depend on MCP being built)
- Round 3: Tasks 3, 4 sequential (client, helpers+tests)
- Round 4: Tasks 5, 6, 7, 8 in parallel (handler modules — all depend on client+helpers)
- Round 5: Tasks 9, 10 sequential (tools schema, server entry — depend on all handlers)
- Round 6: Task 16 (web slot)
- Round 7: Tasks 17, 18, 19 sequential (web UI)
- Round 8: Tasks 20, 21 in parallel (install + uninstall)
- Round 9: Task 22 (bootstrap)
- Round 10: Task 24 (smoke test, in main session)
