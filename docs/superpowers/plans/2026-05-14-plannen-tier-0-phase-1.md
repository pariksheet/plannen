# Plannen Tier 0 — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Tier 0 bootstrap path where new users run Plannen with only `Node ≥ 20` — no Docker, no Supabase CLI — and Claude Code / Claude Desktop talk to the local Postgres via MCP exactly as today.

**Architecture:** Replace the MCP server's `@supabase/supabase-js` data access with a plain `pg.Pool` driven by a single `DATABASE_URL`. Add an embedded-Postgres runtime started by Node, a hand-rolled migration runner, and a Tier-0 SQL overlay that stubs the `auth.uid()` schema via a session GUC. The web app stays Tier-1-only in this phase (Phase 2 covers the `dbClient` refactor). Photo picker, OAuth callbacks, and AI edge-function paths return clean "requires Tier 1" errors when invoked in Tier 0.

**Tech Stack:** TypeScript 5.x, Node 20+, `pg` (node-postgres), `embedded-postgres` (npm), `vitest`, bash for bootstrap scripts.

**Scope (in):** Embedded Postgres + migration runner. Tier-0 SQL overlay. Shared `db.ts` helper. MCP refactor from supabase-js to pg. `bootstrap.sh --tier` flag with Tier 0 default. Doc rewrites. CI guard.

**Scope (out — Phase 2):** Web app `dbClient` refactor. Backend stub for edge functions. Photo picker, transcription, AI-feature MCP tools (these tools return a Tier-1-required error in Phase 1).

**Defaults locked in by spec / brainstorm answers:**
- Tier 0 is the new default for `bootstrap.sh` (no flag).
- Migrations table = `plannen.schema_migrations` (Plannen-owned, not Supabase-named).
- Connection pool helper lives at `mcp/src/db.ts` for now; extracted to a workspace package only if Phase 2 needs sharing.
- Kitchen plugin spec is intentionally NOT touched in this plan.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `mcp/src/db.ts` | `pg.Pool` singleton + `withUserContext(uid, fn)` GUC helper |
| `mcp/src/db.test.ts` | Unit tests for `withUserContext` (sets/unsets GUC correctly) |
| `mcp/src/userResolver.ts` | Resolves `PLANNEN_USER_EMAIL` to user UUID via SQL (replaces `db.auth.admin.listUsers`) |
| `mcp/src/userResolver.test.ts` | Unit test |
| `scripts/lib/plannen-pg.mjs` | Node script: init / start / stop / migrate / status for embedded Postgres |
| `scripts/pg-start.sh` | Thin bash wrapper around `plannen-pg start` |
| `scripts/pg-stop.sh` | Thin bash wrapper around `plannen-pg stop` |
| `scripts/lib/migrate.mjs` | Hand-rolled migration runner (walks `supabase/migrations/*.sql` + overlay, applies in tx, records in `plannen.schema_migrations`) |
| `supabase/migrations-tier0/00000000000000_tier0_compat.sql` | Tier-0 overlay: `auth.uid()` stub, stub `auth.users` + `storage.{buckets,objects}` |
| `docs/INTEGRATIONS.md` | One-pager listing current integrations and the storage-vs-integration rule |
| `.github/workflows/tier-0-bootstrap.yml` | CI: `bootstrap.sh --tier 0` from scratch on every migration-touching PR |

### Modified files

| Path | What changes |
|---|---|
| `mcp/src/index.ts` | Replace `createClient(...)` with `pg.Pool` from `db.ts`; replace `db.from(...)` calls with `pool.query(...)`; replace `uid()` to call `userResolver`; wrap each tool handler in `withUserContext` |
| `mcp/src/profileFacts.ts` | Refactor any `supabase` references (likely import only; logic is pure) |
| `mcp/src/sources.ts` | Same |
| `mcp/src/transcribe.ts` | Add Tier-0 guard: if `PLANNEN_TIER=0`, return clean error from any function that hits an edge function |
| `mcp/package.json` | Add `pg`, `pg-types`, `embedded-postgres`; remove `@supabase/supabase-js` |
| `scripts/bootstrap.sh` | Add `--tier` flag (default `0`); branch the setup steps; default `DATABASE_URL` per tier |
| `.env.example` | Add `PLANNEN_TIER`, `DATABASE_URL`; keep existing vars for Tier 1 |
| `package.json` (root) | Workspace config if `mcp/` isn't already a workspace; expose `pnpm plannen-pg` script |
| `docs/TIERED_DEPLOYMENT_MODEL.md` | Full rewrite around Tier 0–3+ from the spec |
| `README.md` | Update Prerequisites section (Tier 0 default), Setup section, "Why it works" paragraph, Daily workflow |
| `CLAUDE.md` | Update hard rules: migration command is tier-aware now |

---

## Task 0: Verify clean baseline

**Files:** none

- [ ] **Step 1: Confirm worktree state**

```bash
git rev-parse --abbrev-ref HEAD   # expect: worktree-spec+storage_tiers
git log --oneline -3              # expect spec commit on top
```

- [ ] **Step 2: Run existing MCP tests baseline**

```bash
cd mcp && pnpm install && pnpm test
```

Expected: all tests pass (these are the safety net for the upcoming refactor). If any fail pre-refactor, stop and investigate before proceeding.

---

## Task 1: Add `pg` + `embedded-postgres` deps

**Files:**
- Modify: `mcp/package.json`

- [ ] **Step 1: Add deps**

```bash
cd mcp
pnpm add pg @types/pg
pnpm add -D embedded-postgres
```

- [ ] **Step 2: Verify `embedded-postgres` binary downloads on your platform**

```bash
node -e "import('embedded-postgres').then(m => console.log(Object.keys(m)))"
```

Expected: prints export names without throwing. If the binary fails to download, the package is unsuitable — stop and pick the next-best embedded-postgres library (e.g., `@embedded-postgres/postgres`).

- [ ] **Step 3: Commit**

```bash
git add mcp/package.json mcp/pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "mcp: add pg + embedded-postgres deps"
```

---

## Task 2: Embedded Postgres lifecycle script (`plannen-pg.mjs`)

**Files:**
- Create: `scripts/lib/plannen-pg.mjs`
- Create: `scripts/pg-start.sh`
- Create: `scripts/pg-stop.sh`

- [ ] **Step 1: Write the script**

Create `scripts/lib/plannen-pg.mjs`:

```js
#!/usr/bin/env node
// Lifecycle for the Tier 0 embedded Postgres.
// Usage: node scripts/lib/plannen-pg.mjs <init|start|stop|status>
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = process.env.PLANNEN_PG_DATA ?? join(homedir(), '.plannen', 'pgdata')
const PID_FILE = join(homedir(), '.plannen', 'pg.pid')
const PORT = Number(process.env.PLANNEN_PG_PORT ?? 54322)
const USER = 'plannen'
const PASSWORD = 'plannen'
const DB = 'plannen'

function newServer() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })
}

async function init() {
  mkdirSync(join(homedir(), '.plannen'), { recursive: true })
  if (existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    console.log(`pgdata already initialised at ${DATA_DIR}`)
    return
  }
  const pg = newServer()
  await pg.initialise()
  await pg.start()
  await pg.createDatabase(DB)
  writeFileSync(PID_FILE, String(process.pid))
  console.log(`pg initialised at ${DATA_DIR} on port ${PORT}; running.`)
}

async function start() {
  const pg = newServer()
  await pg.start()
  writeFileSync(PID_FILE, String(process.pid))
  console.log(`pg started on port ${PORT}`)
  // keep the process alive
  setInterval(() => {}, 1 << 30)
}

async function stop() {
  if (!existsSync(PID_FILE)) {
    console.log('no pid file; nothing to stop')
    return
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`sent SIGTERM to ${pid}`)
  } catch (e) {
    console.log(`pid ${pid} not running`)
  }
  unlinkSync(PID_FILE)
}

async function status() {
  if (!existsSync(PID_FILE)) {
    console.log('not running (no pid file)')
    process.exit(1)
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try {
    process.kill(pid, 0)
    console.log(`running (pid ${pid}, port ${PORT})`)
  } catch {
    console.log(`stale pid file ${pid}`)
    process.exit(1)
  }
}

const cmd = process.argv[2]
const map = { init, start, stop, status }
if (!map[cmd]) {
  console.error(`usage: plannen-pg.mjs <${Object.keys(map).join('|')}>`)
  process.exit(1)
}
await map[cmd]()
```

- [ ] **Step 2: Bash wrappers**

Create `scripts/pg-start.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$0")/lib/plannen-pg.mjs" start &
disown
echo "pg-start: spawned in background; check ~/.plannen/pg.pid"
```

Create `scripts/pg-stop.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$0")/lib/plannen-pg.mjs" stop
```

- [ ] **Step 3: Make executable and smoke-test**

```bash
chmod +x scripts/pg-start.sh scripts/pg-stop.sh
node scripts/lib/plannen-pg.mjs init
# expect: pg initialised at ~/.plannen/pgdata on port 54322
PGPASSWORD=plannen psql -h 127.0.0.1 -p 54322 -U plannen -d plannen -c 'select 1'
# expect: 1 row returned
node scripts/lib/plannen-pg.mjs stop
```

If `psql` is not installed locally, substitute the smoke test with a tiny Node script that connects via `pg` and runs `SELECT 1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/plannen-pg.mjs scripts/pg-start.sh scripts/pg-stop.sh
git -c commit.gpgsign=false commit -m "scripts: embedded Postgres lifecycle (Tier 0)"
```

---

## Task 3: Tier-0 migration overlay

**Files:**
- Create: `supabase/migrations-tier0/00000000000000_tier0_compat.sql`

- [ ] **Step 1: Write the overlay**

```sql
-- Tier 0 compat overlay. Applied AFTER the main migrations in Tier 0 only.
-- Stubs the Supabase-provided auth/storage schemas with just enough surface
-- to make existing plannen.* policies and triggers compile and evaluate.

-- ---- auth schema -----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- auth.uid() returns the per-connection GUC. Tier 1 has the real function from
-- the GoTrue stack; Tier 0 ships this stub.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

-- auth.users is referenced by the handle_new_user trigger. Tier 0 doesn't fire
-- signups through GoTrue, but the schema reference must resolve. Bootstrap
-- inserts the single user row directly into plannen.users.
CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE
);

-- ---- storage schema --------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id     text PRIMARY KEY,
  name   text,
  public boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS storage.objects (
  bucket_id  text NOT NULL,
  name       text NOT NULL,
  owner      uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata   jsonb,
  PRIMARY KEY (bucket_id, name)
);

-- The initial_schema.sql storage-policy DDL is guarded by pg_policies existence
-- checks, so those CREATE POLICY blocks no-op in Tier 0 (the policies reference
-- supabase-internal roles that don't exist here).
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations-tier0/
git -c commit.gpgsign=false commit -m "db: Tier 0 auth.uid() / storage stub overlay"
```

---

## Task 4: Migration runner

**Files:**
- Create: `scripts/lib/migrate.mjs`

- [ ] **Step 1: Write the runner**

```js
#!/usr/bin/env node
// Migration runner. Walks supabase/migrations/*.sql in order, then (if Tier 0)
// walks supabase/migrations-tier0/*.sql, applying each in a transaction and
// recording the version in plannen.schema_migrations.
//
// Usage: node scripts/lib/migrate.mjs
// Reads DATABASE_URL and PLANNEN_TIER from env (or repo-root .env).

import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

loadDotenv({ path: new URL('../../.env', import.meta.url).pathname })

const DATABASE_URL = process.env.DATABASE_URL
const TIER = process.env.PLANNEN_TIER ?? '0'
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const MIGRATIONS_DIRS = [
  new URL('../../supabase/migrations', import.meta.url).pathname,
  ...(TIER === '0'
    ? [new URL('../../supabase/migrations-tier0', import.meta.url).pathname]
    : []),
]

function listSql(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ version: basename(f, '.sql'), file: join(dir, f) }))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

await client.query(`
  CREATE SCHEMA IF NOT EXISTS plannen;
  CREATE TABLE IF NOT EXISTS plannen.schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`)

const { rows: applied } = await client.query('SELECT version FROM plannen.schema_migrations')
const seen = new Set(applied.map((r) => r.version))

let count = 0
for (const dir of MIGRATIONS_DIRS) {
  for (const { version, file } of listSql(dir)) {
    if (seen.has(version)) continue
    const sql = readFileSync(file, 'utf8')
    process.stdout.write(`applying ${version}... `)
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO plannen.schema_migrations(version) VALUES ($1)', [version])
      await client.query('COMMIT')
      console.log('ok')
      count++
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`FAILED: ${e.message}`)
      process.exit(1)
    }
  }
}

console.log(`done. applied ${count} migration(s).`)
await client.end()
```

- [ ] **Step 2: Smoke-test against a fresh embedded Postgres**

```bash
node scripts/lib/plannen-pg.mjs init &
sleep 2
DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
PLANNEN_TIER=0 \
  node scripts/lib/migrate.mjs
# expect: "applying 00000000000000... ok" twice (main + overlay)
# expect: "done. applied 2 migration(s)."
node scripts/lib/plannen-pg.mjs stop
```

- [ ] **Step 3: Verify `auth.uid()` stub works**

```bash
node scripts/lib/plannen-pg.mjs start &
sleep 2
PGPASSWORD=plannen psql -h 127.0.0.1 -p 54322 -U plannen -d plannen <<'SQL'
SELECT auth.uid();                                                       -- expect NULL
SELECT set_config('app.current_user_id', gen_random_uuid()::text, false);
SELECT auth.uid();                                                       -- expect a uuid
SQL
node scripts/lib/plannen-pg.mjs stop
```

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/migrate.mjs
git -c commit.gpgsign=false commit -m "scripts: tier-aware migration runner"
```

---

## Task 5: Shared `db.ts` helper

**Files:**
- Create: `mcp/src/db.ts`
- Create: `mcp/src/db.test.ts`

- [ ] **Step 1: Write the failing test**

`mcp/src/db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool, withUserContext } from './db.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for db tests')

describe('withUserContext', () => {
  afterAll(async () => { await pool.end() })

  it('sets app.current_user_id for the duration of the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000001'
    const seenInside = await withUserContext(u, async (c) => {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      return rows[0].v
    })
    expect(seenInside).toBe(u)
  })

  it('GUC does not leak to the next checkout', async () => {
    await withUserContext('00000000-0000-0000-0000-000000000001', async () => {})
    const c = await pool.connect()
    try {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      expect(rows[0].v).toBe('')
    } finally { c.release() }
  })

  it('auth.uid() returns the GUC value', async () => {
    const u = '00000000-0000-0000-0000-000000000002'
    const got = await withUserContext(u, async (c) => {
      const { rows } = await c.query('SELECT auth.uid() AS v')
      return rows[0].v
    })
    expect(got).toBe(u)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mcp && pnpm vitest run src/db.test.ts
```

Expected: FAIL — `db.ts` doesn't exist yet.

- [ ] **Step 3: Implement `db.ts`**

```ts
// mcp/src/db.ts — shared pg pool + per-connection user-context helper.
import pg from 'pg'

const { Pool } = pg
type PoolClient = pg.PoolClient

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (set by bootstrap.sh)')
}

export const pool = new Pool({ connectionString: DATABASE_URL })

/**
 * Run `fn` against a pooled client with `app.current_user_id` set to `userId`
 * for the duration of the surrounding transaction. The GUC is transaction-local
 * (`set_config(..., true)`), so it dies on release — no leak between checkouts.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd mcp && pnpm vitest run src/db.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/db.ts mcp/src/db.test.ts
git -c commit.gpgsign=false commit -m "mcp: pg.Pool + withUserContext helper"
```

---

## Task 6: User resolver (replace `auth.admin.listUsers`)

**Files:**
- Create: `mcp/src/userResolver.ts`
- Create: `mcp/src/userResolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp/src/userResolver.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from './db.js'
import { resolveUserIdByEmail } from './userResolver.js'

describe('resolveUserIdByEmail', () => {
  let testUserId: string
  beforeAll(async () => {
    const c = await pool.connect()
    try {
      const { rows } = await c.query(
        "INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), 'resolver-test@plannen.local') RETURNING id",
      )
      testUserId = rows[0].id
    } finally { c.release() }
  })
  afterAll(async () => {
    const c = await pool.connect()
    try { await c.query('DELETE FROM plannen.users WHERE id = $1', [testUserId]) }
    finally { c.release() }
    await pool.end()
  })

  it('returns the uuid for an existing user (case-insensitive)', async () => {
    const id = await resolveUserIdByEmail('RESOLVER-TEST@plannen.local')
    expect(id).toBe(testUserId)
  })

  it('throws when no row exists', async () => {
    await expect(resolveUserIdByEmail('nobody@nowhere.invalid')).rejects.toThrow(/no plannen user/i)
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd mcp && pnpm vitest run src/userResolver.test.ts
```

- [ ] **Step 3: Implement**

```ts
// mcp/src/userResolver.ts
import { pool } from './db.js'

export async function resolveUserIdByEmail(email: string): Promise<string> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    )
    if (rows.length === 0) {
      throw new Error(`No Plannen user found for ${email}. Run scripts/bootstrap.sh or insert a row in plannen.users.`)
    }
    return rows[0].id
  } finally {
    c.release()
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
cd mcp && pnpm vitest run src/userResolver.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add mcp/src/userResolver.ts mcp/src/userResolver.test.ts
git -c commit.gpgsign=false commit -m "mcp: userResolver via pg (replaces auth.admin.listUsers)"
```

---

## Task 7: Refactor `mcp/src/index.ts` from `supabase-js` to `pg`

This is the biggest mechanical task. ~2000-line file. Approach: refactor in stable chunks, run the existing test suite after each.

**Files:**
- Modify: `mcp/src/index.ts`
- Modify: `mcp/src/transcribe.ts` (add Tier-0 guard for edge-function calls)

### Sub-task 7a: replace top-level client init

- [ ] **Step 1: Edit top of `mcp/src/index.ts`**

Replace:

```ts
import { createClient } from '@supabase/supabase-js'
// ...
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
// ...
if (!SERVICE_ROLE_KEY) fatal('SUPABASE_SERVICE_ROLE_KEY is required')
// ...
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'plannen' },
})
```

With:

```ts
import { pool, withUserContext } from './db.js'
import { resolveUserIdByEmail } from './userResolver.js'

const DATABASE_URL = process.env.DATABASE_URL
const PLANNEN_TIER = process.env.PLANNEN_TIER ?? '0'
// ...
if (!DATABASE_URL) fatal('DATABASE_URL is required')
```

And replace the `uid()` resolver:

```ts
let _userId: string | null = null
async function uid(): Promise<string> {
  if (_userId) return _userId
  _userId = await resolveUserIdByEmail(USER_EMAIL)
  return _userId
}
```

- [ ] **Step 2: Verify build fails noisily**

```bash
cd mcp && pnpm build
```

Expected: many TS errors — every `db.from(...)` and `db.rpc(...)` call now references a missing symbol. This is fine; the errors are the worklist for sub-tasks 7b–7n.

### Sub-task 7b: refactor `db.from('table').select()` calls

Walk every `db.from(...).select(...)` (or `.insert`, `.update`, `.delete`, `.eq`, `.in`, `.or`, etc.). Translation rules:

| Supabase pattern | pg equivalent (inside `withUserContext`) |
|---|---|
| `db.from('events').select('*').eq('created_by', uid)` | `await c.query('SELECT * FROM plannen.events WHERE created_by = $1', [uid])` |
| `db.from('events').insert({ ... }).select().single()` | `await c.query('INSERT INTO plannen.events(...) VALUES (...) RETURNING *', [...])` then `.rows[0]` |
| `db.from('x').update({ a: 1 }).eq('id', i)` | `await c.query('UPDATE plannen.x SET a = $1 WHERE id = $2', [1, i])` |
| `db.from('x').delete().eq('id', i)` | `await c.query('DELETE FROM plannen.x WHERE id = $1', [i])` |
| `db.rpc('fn_name', { p_a: 1 })` | `await c.query('SELECT * FROM plannen.fn_name($1)', [1])` (check the function signature first) |

- [ ] **Step 1: For each tool handler, wrap the body in `withUserContext`**

Pattern (before):

```ts
case 'list_events': {
  const userId = await uid()
  const { data, error } = await db.from('events').select('*').eq('created_by', userId).limit(args.limit ?? 10)
  if (error) throw error
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}
```

Pattern (after):

```ts
case 'list_events': {
  const userId = await uid()
  return await withUserContext(userId, async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM plannen.events WHERE created_by = $1 ORDER BY start_ts ASC LIMIT $2',
      [userId, args.limit ?? 10],
    )
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
  })
}
```

- [ ] **Step 2: Work through tool handlers in order (alphabetised by name)**

There are ~40 tool handlers in `index.ts`. Refactor them in batches of 5; after each batch, run:

```bash
pnpm build
```

If TypeScript no longer complains about that batch, commit it:

```bash
git add mcp/src/index.ts
git -c commit.gpgsign=false commit -m "mcp: refactor <batch description> to pg"
```

- [ ] **Step 3: Run the full test suite after the final handler**

```bash
cd mcp && pnpm test
```

Expected: all green (4 test files: `profileFacts`, `recurrence`, `sources`, `transcribe`, plus the new `db` and `userResolver`).

### Sub-task 7c: Tier-1-only feature guards

- [ ] **Step 1: Add a helper near the top of `index.ts`**

```ts
function tier1Only(feature: string): never {
  throw new Error(
    `${feature} requires Tier 1 (Supabase Edge Functions). Run "bash scripts/bootstrap.sh --tier 1" or upgrade your install.`,
  )
}
```

- [ ] **Step 2: Guard every tool handler that hits an edge function**

Find each occurrence of `${SUPABASE_URL}/functions/v1/` (or any `fetch(...)` to a Supabase functions URL) and wrap:

```ts
case 'create_photo_picker_session': {
  if (PLANNEN_TIER === '0') tier1Only('Photo picker')
  // ... existing code that calls the picker-session-create edge function
}
```

Repeat for: `poll_photo_picker_session`, `transcribe_memory`, any image-extraction tools that fetch the AI edge functions.

- [ ] **Step 3: Run tests + smoke**

```bash
cd mcp && pnpm test
PLANNEN_TIER=0 PLANNEN_USER_EMAIL=resolver-test@plannen.local \
  DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  node dist/index.js < /dev/null   # will exit because no stdin, but should not crash on startup
```

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts mcp/src/transcribe.ts
git -c commit.gpgsign=false commit -m "mcp: Tier-1-only guards for edge-function-backed tools"
```

### Sub-task 7d: remove `@supabase/supabase-js`

- [ ] **Step 1: Confirm no remaining imports**

```bash
grep -rn "@supabase/supabase-js" mcp/src/
```

Expected: no matches.

- [ ] **Step 2: Drop dep**

```bash
cd mcp && pnpm remove @supabase/supabase-js
```

- [ ] **Step 3: Build + test one more time**

```bash
pnpm build && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add mcp/package.json mcp/pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "mcp: drop @supabase/supabase-js dep"
```

---

## Task 8: Update `bootstrap.sh` (Tier 0 default)

**Files:**
- Modify: `scripts/bootstrap.sh`
- Modify: `.env.example`

- [ ] **Step 1: Add `--tier` flag parsing at the top of `bootstrap.sh`**

```bash
TIER=0
NON_INTERACTIVE=0
EMAIL=""
INSTALL_PLUGIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --email) EMAIL="$2"; shift 2 ;;
    --install-plugin) INSTALL_PLUGIN=1; shift ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done

case "$TIER" in
  0|1) ;;
  *) echo "unsupported tier: $TIER (use 0 or 1)"; exit 1 ;;
esac
```

- [ ] **Step 2: Branch the setup**

After the `pnpm install` step, branch:

```bash
if [[ "$TIER" == "0" ]]; then
  # Tier 0: embedded Postgres
  node scripts/lib/plannen-pg.mjs init
  bash scripts/pg-start.sh
  export DATABASE_URL="postgres://plannen:plannen@127.0.0.1:54322/plannen"
  PLANNEN_TIER=0 DATABASE_URL="$DATABASE_URL" node scripts/lib/migrate.mjs
  # Insert the single user row directly.
  PGPASSWORD=plannen psql -h 127.0.0.1 -p 54322 -U plannen -d plannen \
    -c "INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), '$EMAIL') ON CONFLICT (email) DO NOTHING"
else
  # Tier 1: existing Supabase path
  supabase start
  supabase migration up
  # existing auth-user-creation block goes here, unchanged
fi
```

- [ ] **Step 3: Write `.env`**

```bash
cat > .env <<EOF
PLANNEN_TIER=$TIER
PLANNEN_USER_EMAIL=$EMAIL
DATABASE_URL=$DATABASE_URL
EOF

if [[ "$TIER" == "1" ]]; then
  cat >> .env <<EOF
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
EOF
fi
```

- [ ] **Step 4: Update `.env.example`**

```bash
# Plannen environment
PLANNEN_TIER=0
PLANNEN_USER_EMAIL=

# Required — connection to whichever Postgres backs your tier
DATABASE_URL=postgres://plannen:plannen@127.0.0.1:54322/plannen

# Tier 1 only — uncomment if running local Supabase
# SUPABASE_URL=http://127.0.0.1:54321
# SUPABASE_SERVICE_ROLE_KEY=

# Optional — AI features (web app only; Claude path doesn't need this)
# ANTHROPIC_API_KEY=

# Optional — Google integrations
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
```

- [ ] **Step 5: Smoke-test from scratch**

```bash
rm -rf ~/.plannen
bash scripts/bootstrap.sh --non-interactive --email you@example.com
# expect: embedded pg comes up, migrations apply, .env written, MCP builds
cd mcp && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add scripts/bootstrap.sh .env.example
git -c commit.gpgsign=false commit -m "bootstrap: --tier flag, Tier 0 default"
```

---

## Task 9: Doc updates

**Files:**
- Modify: `docs/TIERED_DEPLOYMENT_MODEL.md`
- Create: `docs/INTEGRATIONS.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rewrite `docs/TIERED_DEPLOYMENT_MODEL.md`**

Copy the spec's "Tier model" section verbatim as the body of the file, prefaced by the one-line principle. Drop the old Tier 1–4 narrative. Add a short note that publishing/social features are orthogonal to tier choice when they ship.

- [ ] **Step 2: Create `docs/INTEGRATIONS.md`**

```markdown
# Plannen Integrations

> Postgres is Plannen's system of record. Every other place your data shows up
> is an integration: a read-only view, a write-mirror, or an export.

| Surface | Role | Direction | Configured via |
|---|---|---|---|
| Google Calendar | write-mirror | Plannen → GCal | `/plannen-setup` → Google OAuth |
| Google Photos | read-source | GPhotos → Plannen (picker) | `/plannen-setup` → Google OAuth |
| Google Drive | storage-mirror for memory uploads | Plannen ↔ Drive | `/plannen-setup` → Google OAuth |
| WhatsApp / email | notification sink | Plannen → user | edge function settings (Tier 1) |

Integrations are orthogonal to tier choice — pick any tier and any subset of
integrations. New integration proposals get their own design spec.
```

- [ ] **Step 3: Update `README.md`**

Update Prerequisites table — drop the "container runtime" and "Supabase CLI" rows for the default Tier 0 path; keep them in a separate "Tier 1 prerequisites" subsection.

Update Setup section — `bash scripts/bootstrap.sh` is now Tier 0 by default. Mention `--tier 1` for users wanting the existing path.

Update "Why it works" — insert the storage-vs-integration paragraph from the spec.

Update Daily workflow — `bash scripts/pg-start.sh` replaces `bash scripts/local-start.sh` for Tier 0.

Update the top callout banner from "Tier 1 — Fully Local" to "Tier 0 — Bundled, default. See `docs/TIERED_DEPLOYMENT_MODEL.md`."

- [ ] **Step 4: Update `CLAUDE.md`**

Replace the hard rule:

> **Never run `supabase db reset`.** It wipes user data. Apply migrations with `supabase migration up`.

with:

> **Never wipe user data.** Apply migrations with `pnpm exec plannen-pg migrate` in Tier 0 or `supabase migration up` in Tier 1. Back up first via `bash scripts/export-seed.sh` (Tier 1) or `tar` of `~/.plannen/pgdata + ~/.plannen/photos` (Tier 0).

- [ ] **Step 5: Commit**

```bash
git add docs/TIERED_DEPLOYMENT_MODEL.md docs/INTEGRATIONS.md README.md CLAUDE.md
git -c commit.gpgsign=false commit -m "docs: rewrite tier model around Tier 0 default; add INTEGRATIONS.md"
```

---

## Task 10: CI guard for Tier 0 bootstrap

**Files:**
- Create: `.github/workflows/tier-0-bootstrap.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Tier 0 bootstrap

on:
  pull_request:
    paths:
      - 'supabase/migrations/**'
      - 'supabase/migrations-tier0/**'
      - 'scripts/lib/plannen-pg.mjs'
      - 'scripts/lib/migrate.mjs'
      - 'scripts/bootstrap.sh'
      - 'mcp/src/db.ts'
      - 'mcp/src/userResolver.ts'

jobs:
  bootstrap-from-scratch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - run: pnpm install
      - run: bash scripts/bootstrap.sh --non-interactive --email ci@plannen.local --tier 0
      - run: cd mcp && pnpm test
        env:
          DATABASE_URL: postgres://plannen:plannen@127.0.0.1:54322/plannen
          PLANNEN_TIER: '0'
          PLANNEN_USER_EMAIL: ci@plannen.local
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tier-0-bootstrap.yml
git -c commit.gpgsign=false commit -m "ci: Tier 0 bootstrap-from-scratch guard"
```

---

## Task 11: Final integration smoke test

- [ ] **Step 1: Wipe and re-bootstrap from scratch on a clean checkout**

```bash
rm -rf ~/.plannen
bash scripts/pg-stop.sh 2>/dev/null || true
bash scripts/bootstrap.sh --non-interactive --email smoke@plannen.local
```

Expected: success, no Docker prompts, no Supabase CLI calls.

- [ ] **Step 2: Verify MCP can list events (empty result is fine)**

```bash
cd mcp
PLANNEN_USER_EMAIL=smoke@plannen.local \
DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
PLANNEN_TIER=0 \
node -e "
import('./dist/index.js').then(async () => {
  // The MCP normally talks stdio; this is just a startup-doesn't-throw check.
  console.log('mcp startup ok');
  process.exit(0);
});
"
```

- [ ] **Step 3: Run all MCP tests against the fresh DB**

```bash
cd mcp && pnpm test
```

Expected: all green.

- [ ] **Step 4: Verify Tier 1 still works**

```bash
bash scripts/pg-stop.sh
rm -rf ~/.plannen
bash scripts/bootstrap.sh --non-interactive --email smoke@plannen.local --tier 1
cd mcp && pnpm test
```

Expected: all green (Tier 1 path unchanged).

- [ ] **Step 5: Tag the milestone commit**

```bash
git -c commit.gpgsign=false commit --allow-empty -m "milestone: Tier 0 Phase 1 complete"
```

---

## Self-review

**Spec coverage:**

- §"Tier model (replaces ...)" — Tasks 8, 9 (bootstrap + doc rewrite)
- §"The abstraction boundary > Server-side" — Tasks 5, 7 (db.ts + MCP refactor)
- §"Tier 0 starter mechanics" — Tasks 2, 4, 8 (lifecycle, migration runner, bootstrap)
- §"Per-connection identity (the GUC)" — Task 5 (db.ts + tests verify auth.uid() resolution)
- §"Tier-0-only migration overlay" — Task 3
- §"Audit" — Rows 1–4, 12, 15 covered by Tasks 3, 5, 6, 7, 8. Rows 5–8, 11 (photo picker, edge functions, Realtime, web auth) explicitly deferred to Phase 2 via Tier-1-only guards in Task 7c. Row 6 (xattrs) tier-1-only, no action.
- §"Integrations vs storage framing" — Task 9
- §"Kitchen plugin spec updates" — explicitly out of scope per user direction; the spec's edit list stands as a backlog item.
- §"Open Question 2 — Default tier" — resolved: Tier 0 default per user direction; implemented in Task 8.

**Placeholders:** none — every step has either code, a command, or an explicit "do this and verify" check.

**Type consistency:** `withUserContext(userId, fn)` signature used identically in Tasks 5, 6, 7. `resolveUserIdByEmail` returns string in Task 6, consumed as string in Task 7. `PLANNEN_TIER` env var read in Tasks 4, 7, 8 with the same `'0' | '1'` shape.

**One acknowledged risk:** `embedded-postgres` package choice is bound in Task 1 Step 2. If the named package fails to download binaries reliably on the maintainer's macOS-arm64 setup, Task 1 stops the plan — pick a replacement and update the imports in Task 2.
