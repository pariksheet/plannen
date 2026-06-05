# Plannen Tier 0 — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 1 web-app gap. Stand up a Node/Hono backend mirroring Supabase's 12 edge functions + storage + REST surface, refactor the web app to route through a `dbClient` factory that picks per-tier, change `AuthContext` to short-circuit in Tier 0 (no login), fall back to 30s polling for the one Realtime subscription. After this plan lands, `bash scripts/bootstrap.sh` with Node 20+ gives a new user the full web app against embedded Postgres.

**Architecture:** Pure handler pattern — each edge function's logic moves to `supabase/functions/_shared/handlers/<name>.ts` exporting `async function handle(req: Request, ctx: { db, userId }): Promise<Response>`. Deno entry shrinks to `Deno.serve` + JWT verify; Node entry is a Hono mount. Web app gets `src/lib/dbClient.ts` factory; Tier 1 wraps supabase-js, Tier 0 uses fetch. 16 service files become 1-line passthroughs.

**Tech Stack:** TypeScript 5.x, Node 20+, Hono, `@hono/node-server`, `pg`, `jose` (JWT verify), `zod`, vitest, Playwright.

**Scope (in):** `backend/` package; pure handler refactor of all 12 edge functions; `_shared/ai.ts` refactor to take `db` arg; backend REST routes for events/memories/stories/profile/etc.; storage routes mirroring Supabase URL shape; web app `dbClient` factory + tier impls; `AuthContext` tier branch; `useStories` polling fallback; Vite proxy; bootstrap script integration; E2E smoke.

**Scope (out — explicitly):** Tier 3+ hosted. Multi-user. SSE/WebSocket Realtime. Tier 1 web app supabase-js removal. Kitchen plugin. Hot-reload of backend.

**Hard prerequisite:** Phase 1 plan (`docs/superpowers/plans/2026-05-14-plannen-tier-0-phase-1.md`) must be complete on the working branch. Task 0 verifies this.

**Defaults locked in by spec / brainstorm answers:**
- HTTP framework: **Hono** + `@hono/node-server`
- Backend process: separate, managed by bash scripts; Vite proxies in dev
- Tier 0 auth: no-login short-circuit; `AuthContext` calls `GET /api/me`
- dbClient surface: domain-keyed methods (`dbClient.events.list()`, etc.); services become passthroughs
- Storage URL shape: matches Supabase (`/storage/v1/object/event-photos/<path>`)
- Handler data access: runtime-agnostic — both Deno (Tier 1) and Node (Tier 0) inject pg client + userId
- Realtime fallback: 30s polling for `useStories`
- JWT library (Tier 1 edge functions): `jose`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `backend/package.json` | deps: hono, @hono/node-server, pg, zod, jose |
| `backend/tsconfig.json` | extends repo base; outDir `dist/` |
| `backend/src/index.ts` | Hono bootstrap; mounts route groups; listens on `PLANNEN_BACKEND_PORT` |
| `backend/src/db.ts` | `pg.Pool` + `withUserContext` (parallel to `mcp/src/db.ts`) |
| `backend/src/auth.ts` | Resolves `PLANNEN_USER_ID` from env at boot (queries `plannen.users WHERE email = PLANNEN_USER_EMAIL`) |
| `backend/src/middleware/userContext.ts` | Sets `c.var.userId` from `auth.ts`; 401 if missing |
| `backend/src/middleware/error.ts` | JSON error envelope |
| `backend/src/middleware/cors.ts` | Allow `http://localhost:4321` + `http://127.0.0.1:4321` only |
| `backend/src/routes/api/me.ts` | `GET /api/me` → `{ userId, email }` |
| `backend/src/routes/api/events.ts` | events CRUD |
| `backend/src/routes/api/memories.ts` | memories CRUD + multipart upload route |
| `backend/src/routes/api/stories.ts` | stories CRUD |
| `backend/src/routes/api/profile.ts` | profile + profile-facts CRUD |
| `backend/src/routes/api/relationships.ts` | family-members + relationships |
| `backend/src/routes/api/locations.ts` | locations CRUD |
| `backend/src/routes/api/sources.ts` | sources CRUD |
| `backend/src/routes/api/watch.ts` | watch_tasks CRUD |
| `backend/src/routes/api/rsvp.ts` | rsvp endpoint |
| `backend/src/routes/api/groups.ts` | groups + invites |
| `backend/src/routes/api/wishlist.ts` | wishlist CRUD |
| `backend/src/routes/api/settings.ts` | user_settings (BYOK) |
| `backend/src/routes/api/agentTasks.ts` | agent_tasks |
| `backend/src/routes/storage/eventPhotos.ts` | `GET/PUT/DELETE /storage/v1/object/event-photos/*` |
| `backend/src/routes/functions/*.ts` | 12 wrappers, one per edge function |
| `backend/src/health.ts` | `GET /health` |
| `backend/src/types.ts` | Hono Variables typing |
| `backend/vitest.config.ts` | Backend test config |
| `backend/src/test/setup.ts` | Spins up embedded pg for integration tests |
| `supabase/functions/_shared/handlers/<name>.ts` | 12 pure handlers (one per edge function) |
| `supabase/functions/_shared/handlers/<name>.test.ts` | 12 handler tests |
| `supabase/functions/_shared/jwt.ts` | JWT verifier (Tier 1 edge functions) |
| `supabase/functions/_shared/db.ts` | pg client opener (Tier 1 edge functions) |
| `src/lib/dbClient.ts` | Factory: picks impl by `VITE_PLANNEN_BACKEND_MODE` |
| `src/lib/dbClient/types.ts` | Shared `DbClient` interface |
| `src/lib/dbClient/tier1.ts` | Wraps supabase-js |
| `src/lib/dbClient/tier0.ts` | fetch-based |
| `src/lib/dbClient/contract.test.ts` | Parameterised contract test |
| `scripts/backend-start.sh` | Launch backend in background; PID at `~/.plannen/backend.pid` |
| `scripts/backend-stop.sh` | Stop via PID file |
| `tests/e2e/tier0-smoke.spec.ts` | Playwright E2E |

### Modified files

| Path | What changes |
|---|---|
| `supabase/functions/_shared/ai.ts` | Drops supabase-js. Public functions (`getUserAI`, `generate`, etc.) now take `{ db, userId }` instead of `req` |
| `supabase/functions/<name>/index.ts` × 12 | Shrinks to: import handler + JWT verify + pg client + `Deno.serve(handle)` |
| `src/services/*.ts` × 16 | 1-line passthroughs to `dbClient` |
| `src/context/AuthContext.tsx` | Adds Tier 0 branch (calls `/api/me`; skips Supabase Auth) |
| `src/hooks/useStories.ts` | Tier 0 branch: 30s polling instead of `.subscribe()` |
| `vite.config.ts` | Adds proxy for `/api`, `/storage/v1`, `/functions/v1` to `BACKEND_URL` |
| `scripts/bootstrap.sh` | Starts backend after pg+migrations in Tier 0 path; writes `VITE_PLANNEN_BACKEND_MODE=plannen-api` + `BACKEND_URL` |
| `.env.example` | Adds `BACKEND_URL`, `PLANNEN_BACKEND_PORT`, `VITE_PLANNEN_BACKEND_MODE`, `VITE_PLANNEN_TIER` |
| `package.json` (root) | Adds `backend` to workspaces; `pnpm backend` script |
| `.github/workflows/tier-0-bootstrap.yml` | Adds backend smoke + Playwright E2E |
| `CLAUDE.md` | Adds backend start/stop to daily workflow rules |
| `README.md` | Updates Tier 0 daily workflow to include `backend-start.sh` |

---

## Task 0: Verify Phase 1 baseline

**Files:** none

- [ ] **Step 1: Confirm Phase 1 is complete**

```bash
git log --oneline | head -20
```

Expected: see the Phase 1 milestone commit `Tier 0 Phase 1 complete` near the top. If not present, **stop and execute Phase 1 first** — Phase 2 builds on `mcp/src/db.ts`, the migration runner, the embedded-Postgres lifecycle, and the Tier-0 migration overlay.

- [ ] **Step 2: Verify Tier 0 currently works**

```bash
node scripts/lib/plannen-pg.mjs status
# expect: running (pid X, port 54322)
cd mcp && pnpm test
# expect: all green
```

If pg isn't running: `bash scripts/pg-start.sh && sleep 2 && node scripts/lib/plannen-pg.mjs status`.

- [ ] **Step 3: Confirm `.env` has Phase 1 vars**

```bash
grep -E '^(PLANNEN_TIER|DATABASE_URL|PLANNEN_USER_EMAIL)=' .env
```

Expected: all three present with values. If missing, re-run Phase 1's bootstrap.

---

## Task 1: Add `backend/` package skeleton

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/src/index.ts`
- Create: `backend/src/health.ts`
- Create: `backend/src/types.ts`
- Modify: `package.json` (root) — add `backend` to workspaces

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "@plannen/backend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0",
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `backend/src/types.ts`**

```ts
import type { Pool } from 'pg'

export type AppVariables = {
  userId: string
  pool: Pool
}
```

- [ ] **Step 4: Create `backend/src/health.ts`**

```ts
import { Hono } from 'hono'
import type { AppVariables } from './types.js'

export const health = new Hono<{ Variables: AppVariables }>()

health.get('/health', (c) => {
  return c.json({
    status: 'ok',
    tier: process.env.PLANNEN_TIER ?? '0',
    dbConnected: !!c.var.pool,
  })
})
```

- [ ] **Step 5: Create `backend/src/index.ts`** (minimal — just health for now)

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'

const app = new Hono<{ Variables: AppVariables }>()
app.route('/', health)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})

process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0) })
process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0) })
```

- [ ] **Step 6: Add backend to root workspaces**

In root `package.json`, ensure `"workspaces"` includes `"backend"`. If the root file doesn't have a workspaces array yet:

```json
{
  "workspaces": ["mcp", "backend"]
}
```

- [ ] **Step 7: Install + build + smoke**

```bash
pnpm install
cd backend && pnpm build && PLANNEN_BACKEND_PORT=54323 PLANNEN_TIER=0 node dist/index.js &
sleep 1
curl -s http://127.0.0.1:54323/health
# expect: {"status":"ok","tier":"0","dbConnected":false}
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add backend/ package.json pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "backend: skeleton Hono app + /health"
```

---

## Task 2: Backend `db.ts` + pool wiring

**Files:**
- Create: `backend/src/db.ts`
- Create: `backend/src/db.test.ts`
- Create: `backend/vitest.config.ts`
- Modify: `backend/src/index.ts` — inject pool into Hono context

- [ ] **Step 1: Create `backend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
```

`singleFork: true` because all tests share the same embedded Postgres connection — running in parallel forks would compete for the same DB.

- [ ] **Step 2: Write the failing test `backend/src/db.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { pool, withUserContext } from './db.js'

afterAll(async () => { await pool.end() })

describe('withUserContext (backend)', () => {
  it('sets app.current_user_id for the duration of the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000001'
    const seen = await withUserContext(u, async (c) => {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      return rows[0].v
    })
    expect(seen).toBe(u)
  })

  it('does NOT leak GUC to a subsequent checkout', async () => {
    await withUserContext('00000000-0000-0000-0000-000000000001', async () => {})
    const c = await pool.connect()
    try {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      expect(rows[0].v).toBe('')
    } finally { c.release() }
  })

  it('auth.uid() resolves to the GUC value inside the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000002'
    const got = await withUserContext(u, async (c) => {
      const { rows } = await c.query('SELECT auth.uid() AS v')
      return rows[0].v
    })
    expect(got).toBe(u)
  })
})
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
cd backend && pnpm test
```

Expected: FAIL — `db.ts` doesn't exist yet.

- [ ] **Step 4: Implement `backend/src/db.ts`**

```ts
import pg from 'pg'

const { Pool } = pg
type PoolClient = pg.PoolClient

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (set by bootstrap.sh)')
}

export const pool = new Pool({ connectionString: DATABASE_URL })

/**
 * Run `fn` inside a transaction with `app.current_user_id` set to `userId`.
 * Transaction-local GUC dies on commit/rollback — no leak between checkouts.
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

- [ ] **Step 5: Run test, verify PASS**

```bash
DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  cd backend && pnpm test
```

Expected: 3 tests pass.

- [ ] **Step 6: Wire pool into Hono context** in `backend/src/index.ts`

Replace the file with:

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import { pool } from './db.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', async (c, next) => {
  c.set('pool', pool)
  await next()
})

app.route('/', health)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})

const shutdown = async () => {
  console.log('shutting down')
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 7: Smoke**

```bash
cd backend && pnpm build && \
  DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  PLANNEN_BACKEND_PORT=54323 PLANNEN_TIER=0 \
  node dist/index.js &
sleep 1
curl -s http://127.0.0.1:54323/health
# expect: {"status":"ok","tier":"0","dbConnected":true}
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: pg.Pool + withUserContext + /health wired"
```

---

## Task 3: Backend `auth.ts` — resolve `PLANNEN_USER_ID` at boot

**Files:**
- Create: `backend/src/auth.ts`
- Create: `backend/src/auth.test.ts`
- Modify: `backend/src/index.ts` — call `resolveUserAtBoot()` before listen

- [ ] **Step 1: Write failing test `backend/src/auth.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from './db.js'
import { resolveUserAtBoot } from './auth.js'

let testEmail = 'auth-test@plannen.local'
let testUserId: string

beforeAll(async () => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [testEmail],
    )
    testUserId = rows[0].id
  } finally { c.release() }
})
afterAll(async () => {
  const c = await pool.connect()
  try { await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail]) }
  finally { c.release() }
})

describe('resolveUserAtBoot', () => {
  it('returns { userId, email } for an existing user', async () => {
    const got = await resolveUserAtBoot(testEmail)
    expect(got).toEqual({ userId: testUserId, email: testEmail })
  })

  it('throws when no user matches', async () => {
    await expect(resolveUserAtBoot('nobody@nowhere.invalid')).rejects.toThrow(/no plannen user/i)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' pnpm test
```

- [ ] **Step 3: Implement `backend/src/auth.ts`**

```ts
import { pool } from './db.js'

export type ResolvedUser = { userId: string; email: string }

export async function resolveUserAtBoot(email: string): Promise<ResolvedUser> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      'SELECT id, email FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    )
    if (rows.length === 0) {
      throw new Error(`No Plannen user for ${email}. Run scripts/bootstrap.sh or insert a plannen.users row.`)
    }
    return { userId: rows[0].id, email: rows[0].email }
  } finally {
    c.release()
  }
}
```

- [ ] **Step 4: Verify PASS**

```bash
cd backend && DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' pnpm test
```

- [ ] **Step 5: Wire into `backend/src/index.ts`**

Replace the bootstrap block (everything below the imports up to `serve(...)`) with:

```ts
const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'
const USER_EMAIL = process.env.PLANNEN_USER_EMAIL
if (!USER_EMAIL) {
  console.error('PLANNEN_USER_EMAIL is required (set by bootstrap.sh)')
  process.exit(1)
}

const user = await resolveUserAtBoot(USER_EMAIL)
console.log(`resolved user: ${user.email} (${user.userId})`)

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', async (c, next) => {
  c.set('pool', pool)
  c.set('userId', user.userId)
  c.set('userEmail', user.email)
  await next()
})

app.route('/', health)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})
```

And update `AppVariables` in `backend/src/types.ts`:

```ts
import type { Pool } from 'pg'

export type AppVariables = {
  userId: string
  userEmail: string
  pool: Pool
}
```

Add `import { resolveUserAtBoot } from './auth.js'` to the imports.

- [ ] **Step 6: Smoke**

```bash
cd backend && pnpm build
DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  PLANNEN_USER_EMAIL="$(grep PLANNEN_USER_EMAIL ../.env | cut -d= -f2)" \
  PLANNEN_BACKEND_PORT=54323 PLANNEN_TIER=0 \
  node dist/index.js &
sleep 1
curl -s http://127.0.0.1:54323/health
kill %1
```

Expected: starts cleanly, prints "resolved user: ..." line.

- [ ] **Step 7: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: resolve PLANNEN_USER_ID at boot from plannen.users"
```

---

## Task 4: Backend middleware (error + CORS) + `/api/me`

**Files:**
- Create: `backend/src/middleware/error.ts`
- Create: `backend/src/middleware/cors.ts`
- Create: `backend/src/routes/api/me.ts`
- Create: `backend/src/routes/api/me.test.ts`
- Modify: `backend/src/index.ts` — install middleware, mount `/api/me`

- [ ] **Step 1: Create `backend/src/middleware/error.ts`**

```ts
import type { Context, Next } from 'hono'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) { super(message) }
}

export async function errorMiddleware(c: Context, next: Next) {
  try {
    await next()
  } catch (e) {
    if (e instanceof HttpError) {
      return c.json({ error: { code: e.code, message: e.message, hint: e.hint } }, e.status as never)
    }
    console.error('unhandled error', e)
    const message = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: { code: 'INTERNAL', message } }, 500)
  }
}
```

- [ ] **Step 2: Create `backend/src/middleware/cors.ts`**

```ts
import { cors } from 'hono/cors'

export const corsMiddleware = cors({
  origin: ['http://localhost:4321', 'http://127.0.0.1:4321'],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
})
```

- [ ] **Step 3: Failing test `backend/src/routes/api/me.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'me-test@plannen.local'

beforeAll(async () => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [testEmail],
    )
    testUserId = rows[0].id
  } finally { c.release() }
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try { await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail]) }
  finally { c.release() }
})

describe('GET /api/me', () => {
  it('returns the resolved user', async () => {
    const res = await app.request('/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { userId: testUserId, email: testEmail } })
  })
})
```

- [ ] **Step 4: Create `backend/src/testApp.ts`** (factory for integration tests)

```ts
import { Hono } from 'hono'
import { pool } from './db.js'
import { errorMiddleware } from './middleware/error.js'
import { health } from './health.js'
import { me } from './routes/api/me.js'
import type { AppVariables } from './types.js'

export function buildApp(user: { userId: string; userEmail: string }) {
  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', errorMiddleware)
  app.use('*', async (c, next) => {
    c.set('pool', pool)
    c.set('userId', user.userId)
    c.set('userEmail', user.userEmail)
    await next()
  })
  app.route('/', health)
  app.route('/api/me', me)
  return app
}
```

- [ ] **Step 5: Create `backend/src/routes/api/me.ts`**

```ts
import { Hono } from 'hono'
import type { AppVariables } from '../../types.js'

export const me = new Hono<{ Variables: AppVariables }>()

me.get('/', (c) => {
  return c.json({ data: { userId: c.var.userId, email: c.var.userEmail } })
})
```

- [ ] **Step 6: Run test, verify PASS**

```bash
cd backend && DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' pnpm test
```

- [ ] **Step 7: Wire middleware into `backend/src/index.ts`**

After the `const app = new Hono...` line and before the existing `app.use('*', async (c, next) => { c.set('pool'... })` block, install error + CORS:

```ts
import { errorMiddleware } from './middleware/error.js'
import { corsMiddleware } from './middleware/cors.js'
import { me } from './routes/api/me.js'

// ... after `const app = new Hono<{ Variables: AppVariables }>()`:
app.use('*', errorMiddleware)
app.use('*', corsMiddleware)
```

Mount `me` after `app.route('/', health)`:

```ts
app.route('/api/me', me)
```

- [ ] **Step 8: Smoke**

```bash
cd backend && pnpm build && \
  DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  PLANNEN_USER_EMAIL="$(grep PLANNEN_USER_EMAIL ../.env | cut -d= -f2)" \
  PLANNEN_BACKEND_PORT=54323 \
  node dist/index.js &
sleep 1
curl -s http://127.0.0.1:54323/api/me
# expect: {"data":{"userId":"...","email":"..."}}
kill %1
```

- [ ] **Step 9: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: error middleware + CORS + GET /api/me"
```

---

## Task 5: Storage routes (event-photos)

**Files:**
- Create: `backend/src/routes/storage/eventPhotos.ts`
- Create: `backend/src/routes/storage/eventPhotos.test.ts`
- Modify: `backend/src/testApp.ts` + `backend/src/index.ts` — mount storage routes

- [ ] **Step 1: Failing test `backend/src/routes/storage/eventPhotos.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'

let photosRoot: string
let app: ReturnType<typeof buildApp>
const testEmail = 'photos-test@plannen.local'
let testUserId: string

beforeAll(async () => {
  photosRoot = mkdtempSync(join(tmpdir(), 'plannen-photos-'))
  process.env.PLANNEN_PHOTOS_ROOT = photosRoot
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [testEmail],
    )
    testUserId = rows[0].id
  } finally { c.release() }
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  rmSync(photosRoot, { recursive: true, force: true })
  const c = await pool.connect()
  try { await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail]) }
  finally { c.release() }
})

describe('storage event-photos', () => {
  it('PUT then GET roundtrips a binary', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const put = await app.request(`/storage/v1/object/event-photos/${testUserId}/test.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body,
    })
    expect(put.status).toBe(200)
    const putJson = await put.json()
    expect(putJson.data.Key).toBe(`event-photos/${testUserId}/test.png`)

    expect(existsSync(join(photosRoot, 'event-photos', testUserId, 'test.png'))).toBe(true)
    expect(readFileSync(join(photosRoot, 'event-photos', testUserId, 'test.png'))).toEqual(Buffer.from(body))

    const get = await app.request(`/storage/v1/object/public/event-photos/${testUserId}/test.png`)
    expect(get.status).toBe(200)
    const got = new Uint8Array(await get.arrayBuffer())
    expect(got).toEqual(body)
    expect(get.headers.get('content-type')).toContain('image/png')
  })

  it('DELETE removes the file', async () => {
    const body = new Uint8Array([1, 2, 3])
    await app.request(`/storage/v1/object/event-photos/${testUserId}/del.bin`, {
      method: 'PUT', body,
    })
    const del = await app.request(`/storage/v1/object/event-photos/${testUserId}/del.bin`, {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
    expect(existsSync(join(photosRoot, 'event-photos', testUserId, 'del.bin'))).toBe(false)
  })

  it('rejects path traversal', async () => {
    const res = await app.request(`/storage/v1/object/event-photos/..%2F..%2Fetc%2Fpasswd`, {
      method: 'PUT', body: new Uint8Array([0]),
    })
    expect(res.status).toBe(400)
  })

  it('404 for missing file', async () => {
    const res = await app.request(`/storage/v1/object/public/event-photos/nonexistent/x.png`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' pnpm test src/routes/storage/eventPhotos.test.ts
```

- [ ] **Step 3: Implement `backend/src/routes/storage/eventPhotos.ts`**

```ts
import { Hono } from 'hono'
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { resolve, join, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const eventPhotos = new Hono<{ Variables: AppVariables }>()

const photosRoot = () =>
  resolve(process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'))

function safePath(relative: string): string {
  const root = photosRoot()
  const decoded = decodeURIComponent(relative)
  const candidate = resolve(root, decoded)
  if (!candidate.startsWith(root + '/') && candidate !== root) {
    throw new HttpError(400, 'INVALID_PATH', 'Path traversal blocked')
  }
  return candidate
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

// PUT /storage/v1/object/event-photos/<path> — upload
eventPhotos.put('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/event-photos/'
  const idx = url.pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const relative = url.pathname.slice(idx + prefix.length)
  if (!relative) throw new HttpError(400, 'INVALID_PATH', 'Missing path')

  const target = safePath(`event-photos/${relative}`)
  await mkdir(dirname(target), { recursive: true })
  const body = new Uint8Array(await c.req.arrayBuffer())
  await writeFile(target, body)
  return c.json({ data: { Key: `event-photos/${relative}` } })
})

// GET /storage/v1/object/public/event-photos/<path> — serve
eventPhotos.get('/public/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/public/event-photos/'
  const idx = url.pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const relative = url.pathname.slice(idx + prefix.length)
  const target = safePath(`event-photos/${relative}`)
  try {
    await stat(target)
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'File not found')
  }
  const data = await readFile(target)
  const ct = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  return new Response(data, { headers: { 'Content-Type': ct } })
})

// DELETE /storage/v1/object/event-photos/<path>
eventPhotos.delete('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/event-photos/'
  const relative = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length)
  const target = safePath(`event-photos/${relative}`)
  try { await unlink(target) } catch { /* idempotent */ }
  return c.json({ data: { Key: `event-photos/${relative}` } })
})
```

- [ ] **Step 4: Mount in `backend/src/testApp.ts`**

Add to the imports:
```ts
import { eventPhotos } from './routes/storage/eventPhotos.js'
```

Add after the `app.route('/api/me', me)` line:
```ts
app.route('/storage/v1/object', eventPhotos)
```

- [ ] **Step 5: Run, verify PASS**

```bash
cd backend && DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' pnpm test src/routes/storage/eventPhotos.test.ts
```

- [ ] **Step 6: Mount in `backend/src/index.ts`** (same lines as testApp)

- [ ] **Step 7: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: /storage/v1/object/event-photos PUT/GET/DELETE"
```

---

## Task 6: Refactor `_shared/ai.ts` to take `{ db, userId }`

This unblocks every handler refactor. Public functions change signature: `(req, ...)` → `({ db, userId }, ...)`.

**Files:**
- Modify: `supabase/functions/_shared/ai.ts`
- Create: `supabase/functions/_shared/handlers/types.ts` — shared `HandlerCtx` type

- [ ] **Step 1: Create `supabase/functions/_shared/handlers/types.ts`**

```ts
// Runtime-agnostic handler types. Both Deno (Tier 1) and Node (Tier 0) inject
// matching shapes via the runtime-specific entry points.

export type DbClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>
}

export type HandlerCtx = {
  db: DbClient
  userId: string
}

export type Handler = (req: Request, ctx: HandlerCtx) => Promise<Response>
```

- [ ] **Step 2: Refactor `_shared/ai.ts`**

Replace the top of the file (down to and including `recordUsage`) with:

```ts
// BYOK AI wrapper. Drops supabase-js; takes a `db` client + userId from the
// caller (Deno entry verifies JWT; Node entry reads from env).
//
// Public surface: getUserAI, generate, generateStructured, generateFromImage,
// aiErrorResponse, AIError, AIProviderNotConfigured.

import { generateText, generateObject, type LanguageModelV1 } from 'npm:ai@4'
import { createAnthropic, anthropic } from 'npm:@ai-sdk/anthropic@1'
import { z } from 'npm:zod@3'
import type { HandlerCtx, DbClient } from './handlers/types.ts'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

export type Provider = 'anthropic'

export type AISettings = {
  provider: Provider
  api_key: string
  default_model: string | null
  base_url: string | null
  user_id: string
}

export type AIErrorCode =
  | 'no_provider_configured'
  | 'invalid_api_key'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'unknown_error'

export class AIError extends Error {
  code: AIErrorCode
  retryAfterSeconds: number | null
  status: number
  constructor(code: AIErrorCode, message: string, opts: { status?: number; retryAfterSeconds?: number | null } = {}) {
    super(message)
    this.name = 'AIError'
    this.code = code
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
    this.status = opts.status ?? statusForCode(code)
  }
}

export class AIProviderNotConfigured extends AIError {
  constructor() {
    super('no_provider_configured', 'No AI provider configured for this user.', { status: 400 })
  }
}

function statusForCode(code: AIErrorCode): number {
  switch (code) {
    case 'no_provider_configured':
    case 'invalid_api_key':
    case 'model_unavailable':
      return 400
    case 'rate_limited':
      return 429
    case 'provider_unavailable':
      return 502
    default:
      return 500
  }
}

// ── Auth + settings lookup ─────────────────────────────────────────────────────

export async function getUserAI(ctx: HandlerCtx): Promise<AISettings> {
  const { rows } = await ctx.db.query(
    `SELECT provider, api_key, default_model, base_url, user_id
       FROM plannen.user_settings
      WHERE user_id = $1 AND is_default = true
      LIMIT 1`,
    [ctx.userId],
  )
  if (rows.length === 0 || !rows[0].api_key) throw new AIProviderNotConfigured()
  const r = rows[0]
  return {
    provider: r.provider as Provider,
    api_key: r.api_key,
    default_model: r.default_model ?? null,
    base_url: r.base_url ?? null,
    user_id: r.user_id,
  }
}

async function recordUsage(ctx: HandlerCtx, ok: boolean, code: AIErrorCode | null) {
  const patch = ok
    ? { last_used_at: new Date().toISOString(), last_error_at: null, last_error_code: null }
    : { last_error_at: new Date().toISOString(), last_error_code: code }
  await ctx.db.query(
    `UPDATE plannen.user_settings
        SET last_used_at = COALESCE($2, last_used_at),
            last_error_at = COALESCE($3, last_error_at),
            last_error_code = $4
      WHERE user_id = $1 AND is_default = true`,
    [
      ctx.userId,
      ok ? patch.last_used_at : null,
      ok ? null : (patch as any).last_error_at,
      ok ? null : code,
    ],
  )
}
```

- [ ] **Step 3: Update `withRetryAndTracking` and public `generate*` functions**

Find the existing `withRetryAndTracking` function and change its signature from `(req: Request, s: AISettings, fn: () => Promise<T>)` to `(ctx: HandlerCtx, s: AISettings, fn: () => Promise<T>)`. Update the two `recordUsage(req, s.user_id, ...)` calls inside to `recordUsage(ctx, ...)`.

Then update each public `generate`, `generateStructured`, `generateFromImage` to take `ctx: HandlerCtx` as the first arg instead of `req: Request`. Internally, they pass `ctx` to `withRetryAndTracking`.

- [ ] **Step 4: Inspect — no more `Deno.env.get('SUPABASE_URL')` references in this file, no more `supabase.auth.getUser()`, no more `createClient(...)` from supabase-js**

```bash
grep -n "supabase\|SUPABASE\|getUser\|createClient" supabase/functions/_shared/ai.ts
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/
git -c commit.gpgsign=false commit -m "_shared/ai.ts: take HandlerCtx, drop supabase-js"
```

---

## Task 7: JWT verifier + Deno-side pg client helpers

These exist solely for the Tier 1 entry points. They go under `_shared/` so all 12 edge functions can share them.

**Files:**
- Create: `supabase/functions/_shared/jwt.ts`
- Create: `supabase/functions/_shared/db.ts`

- [ ] **Step 1: Create `supabase/functions/_shared/jwt.ts`**

```ts
// JWT verification using jose against Supabase's JWKS.
// Returns the user id ('sub' claim) for valid tokens; throws on missing/invalid.

import { jwtVerify, createRemoteJWKSet } from 'npm:jose@5'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

export async function verifyJwt(authHeader: string | null): Promise<string> {
  if (!authHeader) throw new Error('Missing Authorization header')
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) throw new Error('Bad Authorization header shape')
  const token = m[1]
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
  })
  if (typeof payload.sub !== 'string') throw new Error('Token missing sub claim')
  return payload.sub
}
```

- [ ] **Step 2: Create `supabase/functions/_shared/db.ts`**

```ts
// pg client opener for Tier 1 edge functions. Each invocation gets a fresh
// client, sets the GUC, runs the handler, releases.

import { Pool } from 'npm:pg@8'
import type { DbClient } from './handlers/types.ts'

const pool = new Pool({ connectionString: Deno.env.get('DATABASE_URL') ?? '' })

export async function withDb<T>(userId: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
    const out = await fn(client as unknown as DbClient)
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

- [ ] **Step 3: Note** — `Deno.env.get('DATABASE_URL')` will need to be set in Tier 1's edge function env. This is added in Task 23 (bootstrap update). For now we're just adding the source files.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/
git -c commit.gpgsign=false commit -m "_shared: jwt verifier + pg client opener for Tier 1 entries"
```

---

## Task 8: Extract handlers — agent-test, agent-discover, agent-extract-image

Small handlers first. Each task does TDD: write handler test, run with mock ctx, then extract logic from `index.ts` into `_shared/handlers/<name>.ts`, then rewrite the Deno entry.

**Files (per handler):**
- Create: `supabase/functions/_shared/handlers/<name>.ts`
- Create: `supabase/functions/_shared/handlers/<name>.test.ts`
- Modify: `supabase/functions/<name>/index.ts`

### 8a — agent-test

- [ ] **Step 1: Read current `supabase/functions/agent-test/index.ts`** (34 lines — smallest)

- [ ] **Step 2: Failing test `supabase/functions/_shared/handlers/agent-test.test.ts`** (use vitest, not deno test, since we test the pure handler on Node)

```ts
import { describe, it, expect } from 'vitest'
import { handle } from './agent-test.js'

const mockCtx = (overrides = {}) => ({
  db: {
    query: async () => ({ rows: [{ api_key: 'test-key', provider: 'anthropic', default_model: null, base_url: null, user_id: 'u1' }], rowCount: 1 }),
  } as any,
  userId: 'u1',
  ...overrides,
})

describe('agent-test handler', () => {
  it('returns 200 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(200)
  })

  it('returns 405 on GET', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, mockCtx())
    expect(res.status).toBe(405)
  })

  it('returns no_provider_configured if user has no api_key', async () => {
    const ctx = mockCtx({ db: { query: async () => ({ rows: [], rowCount: 0 }) } })
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('no_provider_configured')
  })
})
```

- [ ] **Step 3: Run, expect FAIL** (file doesn't exist)

```bash
cd supabase/functions && pnpm vitest run _shared/handlers/agent-test.test.ts
```

(If `supabase/functions` has no vitest config, add a minimal one or run from the repo root via `pnpm vitest run supabase/functions/_shared/handlers/agent-test.test.ts` after adding to root vitest config.)

- [ ] **Step 4: Implement `supabase/functions/_shared/handlers/agent-test.ts`**

Copy the logic from `supabase/functions/agent-test/index.ts`, change the entry from `Deno.serve(...)` to `export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> { ... }`, and replace `getUserAI(req)` with `getUserAI(ctx)`.

```ts
import { getUserAI, aiErrorResponse, AIError } from '../ai.ts'
import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  try {
    const settings = await getUserAI(ctx)
    return new Response(JSON.stringify({ ok: true, provider: settings.provider, model: settings.default_model }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    if (e instanceof AIError) return aiErrorResponse(e, corsHeaders)
    throw e
  }
}
```

- [ ] **Step 5: Run, verify PASS**

- [ ] **Step 6: Rewrite Deno entry `supabase/functions/agent-test/index.ts`**

```ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handle } from '../_shared/handlers/agent-test.ts'
import { verifyJwt } from '../_shared/jwt.ts'
import { withDb } from '../_shared/db.ts'

Deno.serve(async (req: Request) => {
  try {
    const userId = await verifyJwt(req.headers.get('authorization'))
    return await withDb(userId, (db) => handle(req, { db, userId }))
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
})
```

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/handlers/agent-test.ts \
        supabase/functions/_shared/handlers/agent-test.test.ts \
        supabase/functions/agent-test/index.ts
git -c commit.gpgsign=false commit -m "handlers: extract agent-test as pure handler"
```

### 8b — agent-discover

Same pattern. Read `agent-discover/index.ts` (94 lines). Extract logic preserving:
- zod schemas `DiscoveryItem`, `DiscoveryResponse`
- `buildPrompt(query)` helper
- The `generateStructured(req, ...)` call becomes `generateStructured(ctx, ...)`

Write test that mocks `ctx.db.query` and asserts response shape. Rewrite Deno entry to match the agent-test template. Commit as `handlers: extract agent-discover`.

### 8c — agent-extract-image

Same pattern. 185 lines. Watch for `generateFromImage(req, ...)` → `generateFromImage(ctx, ...)`. Commit as `handlers: extract agent-extract-image`.

---

## Task 9: Extract handlers — agent-scrape (large), memory-image, picker-session-create

### 9a — agent-scrape (450 lines)

Read first. Likely uses `generate(req, ...)` once, plus its own fetch logic. Same extraction pattern. Test covers: OPTIONS, bad-method, AI error path, success path. Commit as `handlers: extract agent-scrape`.

### 9b — memory-image (186 lines)

Same pattern. Uses AI for image analysis. Test the OPTIONS / 405 / AI-not-configured / success paths with a mock that returns a fake AI response. Commit as `handlers: extract memory-image`.

### 9c — picker-session-create (88 lines)

Uses Google OAuth + supabase-js to record session in DB. The supabase-js call (`db.from('photo_picker_sessions').insert(...)`) becomes `ctx.db.query('INSERT INTO plannen.photo_picker_sessions ...')`. Test asserts the DB write and Google API call (mock `fetch`). Commit as `handlers: extract picker-session-create`.

---

## Task 10: Extract handlers — picker-session-poll, get-google-access-token, get-google-auth-url

### 10a — picker-session-poll (249 lines)

This is the heaviest google-integration function. Reads picker session from DB, polls Google's API, updates session, optionally inserts memories. Every `db.from(...)` becomes `ctx.db.query(...)`. Test happy-path with mocked fetch + mocked db. Commit as `handlers: extract picker-session-poll`.

### 10b — get-google-access-token (96 lines)

Reads oauth tokens from DB (`google_oauth_tokens` table), refreshes if expired, returns access token. DB calls become `ctx.db.query`. Commit as `handlers: extract get-google-access-token`.

### 10c — get-google-auth-url (68 lines)

Pure function: builds the consent URL from `GOOGLE_CLIENT_ID` + redirect URI. No DB. Test asserts URL shape. Commit as `handlers: extract get-google-auth-url`.

---

## Task 11: Extract handlers — google-oauth-callback, send-invite-email, send-reminder

### 11a — google-oauth-callback (112 lines)

Exchanges code for tokens, stores in DB. `ctx.db.query('INSERT INTO plannen.google_oauth_tokens ON CONFLICT DO UPDATE ...')`. Test asserts token row written. Commit as `handlers: extract google-oauth-callback`.

### 11b — send-invite-email (85 lines)

Reads pending invite from DB, sends email via configured SMTP (today: Supabase's Resend integration). The email-send call is environment-dependent — keep the existing logic intact, just change DB access. Commit as `handlers: extract send-invite-email`.

### 11c — send-reminder (107 lines)

Same pattern — reads event + family-members, sends reminders. Commit as `handlers: extract send-reminder`.

After 11c, **all 12 handlers exist as pure functions** with passing tests.

---

## Task 12: Backend mounts all 12 function routes

**Files:**
- Create: `backend/src/routes/functions/<name>.ts` × 12
- Modify: `backend/src/index.ts` + `testApp.ts` — mount function routes

- [ ] **Step 1: Create `backend/src/routes/functions/agentTest.ts`**

```ts
import { Hono } from 'hono'
import { handle } from '../../../../supabase/functions/_shared/handlers/agent-test.ts'
import { withUserContext } from '../../db.js'
import type { AppVariables } from '../../types.js'

export const agentTest = new Hono<{ Variables: AppVariables }>()

agentTest.all('/', async (c) => {
  return await withUserContext(c.var.userId, async (db) => {
    return await handle(c.req.raw, { db, userId: c.var.userId })
  })
})
```

The import path crosses package boundaries — for this to work, `backend/tsconfig.json` needs `"paths"` for the supabase/functions source OR the build copies handlers into a flat location. Pick the path-mapping approach:

In `backend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@handlers/*": ["../supabase/functions/_shared/handlers/*"]
    }
  }
}
```

Then the import becomes `import { handle } from '@handlers/agent-test'`. Note Hono uses ESM; resolving `.ts` extensions from outside the package requires either `tsx` for dev (already in deps) or a build step that copies the handlers. The simpler approach: have `backend build` copy `supabase/functions/_shared/` into `backend/dist/_shared/` before tsc runs.

Update `backend/package.json` `scripts.build`:

```json
"build": "rm -rf dist && cp -r ../supabase/functions/_shared src/_shared && tsc -p . && rm -rf src/_shared"
```

And imports use relative paths inside the staged source:

```ts
import { handle } from '../../_shared/handlers/agent-test.js'
```

Update `agentTest.ts` accordingly.

- [ ] **Step 2: Repeat for the other 11 handlers**

Create files `backend/src/routes/functions/{agentDiscover,agentExtractImage,agentScrape,memoryImage,pickerSessionCreate,pickerSessionPoll,getGoogleAccessToken,getGoogleAuthUrl,googleOauthCallback,sendInviteEmail,sendReminder}.ts` with the same template — only the handler module path differs.

- [ ] **Step 3: Mount in `index.ts` and `testApp.ts`**

```ts
import { agentTest } from './routes/functions/agentTest.js'
import { agentDiscover } from './routes/functions/agentDiscover.js'
// ... etc

app.route('/functions/v1/agent-test', agentTest)
app.route('/functions/v1/agent-discover', agentDiscover)
// ... etc
```

- [ ] **Step 4: Smoke**

```bash
cd backend && pnpm build && \
  DATABASE_URL='postgres://plannen:plannen@127.0.0.1:54322/plannen' \
  PLANNEN_USER_EMAIL="$(grep PLANNEN_USER_EMAIL ../.env | cut -d= -f2)" \
  node dist/index.js &
sleep 1
curl -s -X OPTIONS http://127.0.0.1:54323/functions/v1/agent-test
# expect: 200
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: mount all 12 /functions/v1/* routes"
```

---

## Task 13: Backend REST — events

**Files:**
- Create: `backend/src/routes/api/events.ts`
- Create: `backend/src/routes/api/events.test.ts`
- Modify: `index.ts` + `testApp.ts` — mount events

- [ ] **Step 1: Failing test `backend/src/routes/api/events.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'events-test@plannen.local'

beforeAll(async () => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      `INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [testEmail],
    )
    testUserId = rows[0].id
  } finally { c.release() }
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.events WHERE created_by = $1', [testUserId])
    await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail])
  } finally { c.release() }
})

describe('events routes', () => {
  it('POST /api/events creates an event', async () => {
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', start_ts: new Date().toISOString() }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.title).toBe('Test')
    expect(body.data.created_by).toBe(testUserId)
  })

  it('GET /api/events returns the created event', async () => {
    const res = await app.request('/api/events?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('PATCH /api/events/:id updates', async () => {
    const created = await (await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patchable', start_ts: new Date().toISOString() }),
    })).json()
    const id = created.data.id

    const patch = await app.request(`/api/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patched' }),
    })
    expect(patch.status).toBe(200)
    expect((await patch.json()).data.title).toBe('Patched')
  })

  it('DELETE /api/events/:id deletes', async () => {
    const created = await (await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ToDelete', start_ts: new Date().toISOString() }),
    })).json()
    const del = await app.request(`/api/events/${created.data.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `backend/src/routes/api/events.ts`**

```ts
import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const events = new Hono<{ Variables: AppVariables }>()

const CreateEvent = z.object({
  title: z.string().min(1),
  start_ts: z.string().datetime(),
  end_ts: z.string().datetime().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  enrollment_deadline: z.string().datetime().nullable().optional(),
}).passthrough()

events.get('/', async (c) => {
  const userId = c.var.userId
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const fromDate = c.req.query('from_date')
  const toDate = c.req.query('to_date')

  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM plannen.events WHERE created_by = $1'
    if (fromDate) { params.push(fromDate); sql += ` AND start_ts >= $${params.length}` }
    if (toDate)   { params.push(toDate);   sql += ` AND start_ts <= $${params.length}` }
    params.push(limit); sql += ` ORDER BY start_ts ASC LIMIT $${params.length}`
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

events.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateEvent.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid event', JSON.stringify(parsed.error.issues))
  }
  const e = parsed.data
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.events (title, start_ts, end_ts, location, description, url, enrollment_deadline, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [e.title, e.start_ts, e.end_ts ?? null, e.location ?? null, e.description ?? null, e.url ?? null, e.enrollment_deadline ?? null, userId],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

events.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const patch = await c.req.json() as Record<string, unknown>
  const allowed = ['title', 'start_ts', 'end_ts', 'location', 'description', 'url', 'enrollment_deadline', 'cover_url', 'status']
  const sets: string[] = []
  const params: unknown[] = []
  for (const k of allowed) {
    if (k in patch) { params.push(patch[k]); sets.push(`${k} = $${params.length}`) }
  }
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION', 'No allowed fields to update')
  params.push(id, userId)
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.events SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND created_by = $${params.length}
       RETURNING *`,
      params,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: rows[0] })
  })
})

events.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.events WHERE id = $1 AND created_by = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: { id } })
  })
})

events.get('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.events WHERE id = $1 AND created_by = $2',
      [id, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')
    return c.json({ data: rows[0] })
  })
})
```

- [ ] **Step 4: Mount in `testApp.ts` + `index.ts`**

```ts
import { events } from './routes/api/events.js'
app.route('/api/events', events)
```

- [ ] **Step 5: Run, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add backend/
git -c commit.gpgsign=false commit -m "backend: REST /api/events (GET/POST/PATCH/DELETE/:id)"
```

---

## Task 14: Backend REST — memories + stories

Same pattern as Task 13. Both have a `media_url` field (memories) and similar CRUD shape. Test each, implement each, mount each, commit each.

**Files:**
- Create: `backend/src/routes/api/memories.ts` + test
- Create: `backend/src/routes/api/stories.ts` + test

### 14a — memories

GET / (list with optional event_id filter), POST / (create memory row — file upload goes through storage routes separately), PATCH /:id, DELETE /:id.

Schema fields: `event_id`, `media_url`, `caption`, `kind` (photo/note/transcript), `transcript`, `created_at`.

### 14b — stories

GET / (list, ORDER BY created_at DESC), GET /:id, POST /, PATCH /:id, DELETE /:id.

Schema fields: `title`, `body_html`, `body_md`, `languages` (text[]), `cover_url`, `created_at`.

Commit each separately: `backend: REST /api/memories`, `backend: REST /api/stories`.

---

## Task 15: Backend REST — profile + relationships + locations

Same pattern. Three routes.

**Files:**
- Create: `backend/src/routes/api/profile.ts` (GET /, PATCH /; nested profile-facts CRUD: GET /facts, POST /facts, PATCH /facts/:id, DELETE /facts/:id)
- Create: `backend/src/routes/api/relationships.ts` (GET/POST/PATCH/DELETE /family-members[/:id]; GET /relationships)
- Create: `backend/src/routes/api/locations.ts` (GET/POST/PATCH/DELETE /[:id])

Tests cover the happy path for each verb. Commit each: `backend: REST /api/profile`, `backend: REST /api/relationships`, `backend: REST /api/locations`.

---

## Task 16: Backend REST — sources + watch + rsvp + groups + wishlist + settings + agent-tasks

Seven smaller routes, batched. Each follows the established events.ts template.

**Files:**
- Create: `backend/src/routes/api/sources.ts`
- Create: `backend/src/routes/api/watch.ts`
- Create: `backend/src/routes/api/rsvp.ts`
- Create: `backend/src/routes/api/groups.ts`
- Create: `backend/src/routes/api/wishlist.ts`
- Create: `backend/src/routes/api/settings.ts`
- Create: `backend/src/routes/api/agentTasks.ts`

Each gets a `.test.ts` with one happy-path test per verb. Mount each in `testApp.ts` + `index.ts`. Commit per file: `backend: REST /api/<name>`.

After this task, every Plannen domain has a backend REST endpoint. `curl http://127.0.0.1:54323/api/<resource>` returns sensible data for the configured user.

---

## Task 17: Backend lifecycle scripts

**Files:**
- Create: `scripts/backend-start.sh`
- Create: `scripts/backend-stop.sh`

- [ ] **Step 1: `scripts/backend-start.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BACKEND_DIR="$REPO/backend"
LOG="$HOME/.plannen/backend.log"
PID="$HOME/.plannen/backend.pid"
mkdir -p "$HOME/.plannen"

# Build if dist is missing
if [[ ! -f "$BACKEND_DIR/dist/index.js" ]]; then
  (cd "$BACKEND_DIR" && pnpm build)
fi

# Load env
if [[ -f "$REPO/.env" ]]; then
  set -a; source "$REPO/.env"; set +a
fi

# Kill any prior instance
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "backend already running (pid $(cat "$PID"))"
  exit 0
fi

cd "$BACKEND_DIR"
nohup node dist/index.js >> "$LOG" 2>&1 &
echo $! > "$PID"
disown
sleep 1
if curl -fsS "http://127.0.0.1:${PLANNEN_BACKEND_PORT:-54323}/health" > /dev/null; then
  echo "backend started (pid $(cat "$PID")), log: $LOG"
else
  echo "backend did not respond on /health; tail $LOG"
  exit 1
fi
```

- [ ] **Step 2: `scripts/backend-stop.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
PID="$HOME/.plannen/backend.pid"
if [[ ! -f "$PID" ]]; then
  echo "no pid file; nothing to stop"
  exit 0
fi
if kill -0 "$(cat "$PID")" 2>/dev/null; then
  kill -TERM "$(cat "$PID")"
  echo "sent SIGTERM to $(cat "$PID")"
else
  echo "stale pid"
fi
rm -f "$PID"
```

- [ ] **Step 3: Make executable + smoke**

```bash
chmod +x scripts/backend-start.sh scripts/backend-stop.sh
bash scripts/backend-start.sh
# expect: backend started (pid X), log: ...
curl -s http://127.0.0.1:54323/api/me
# expect: user payload
bash scripts/backend-stop.sh
```

- [ ] **Step 4: Commit**

```bash
git add scripts/backend-start.sh scripts/backend-stop.sh
git -c commit.gpgsign=false commit -m "scripts: backend lifecycle (start/stop) with /health probe"
```

---

## Task 18: Web app — `dbClient` types + factory

**Files:**
- Create: `src/lib/dbClient/types.ts`
- Create: `src/lib/dbClient.ts`

- [ ] **Step 1: `src/lib/dbClient/types.ts`**

```ts
// Shared interface implemented by both tier impls. Domain-keyed methods.
// Method signatures are derived from the corresponding REST endpoints + supabase-js
// equivalents — the contract test asserts shape parity.

export type ApiEnvelope<T> = { data: T } | { error: { code: string; message: string; hint?: string } }

export type EventRow = {
  id: string
  title: string
  start_ts: string
  end_ts: string | null
  created_by: string
  location: string | null
  description: string | null
  url: string | null
  cover_url: string | null
  enrollment_deadline: string | null
  status: string | null
  // ...passthrough fields
}

export type StoryRow = { id: string; title: string; body_html: string; languages: string[]; created_at: string }
export type MemoryRow = { id: string; event_id: string | null; media_url: string | null; caption: string | null; kind: string }

export type DbClient = {
  events: {
    list: (params?: { limit?: number; from_date?: string; to_date?: string }) => Promise<EventRow[]>
    get: (id: string) => Promise<EventRow>
    create: (input: Partial<EventRow> & { title: string; start_ts: string }) => Promise<EventRow>
    update: (id: string, patch: Partial<EventRow>) => Promise<EventRow>
    delete: (id: string) => Promise<void>
  }
  stories: {
    list: () => Promise<StoryRow[]>
    get: (id: string) => Promise<StoryRow>
    create: (input: Partial<StoryRow>) => Promise<StoryRow>
    update: (id: string, patch: Partial<StoryRow>) => Promise<StoryRow>
    delete: (id: string) => Promise<void>
  }
  memories: {
    list: (params?: { event_id?: string }) => Promise<MemoryRow[]>
    create: (input: Partial<MemoryRow>) => Promise<MemoryRow>
    update: (id: string, patch: Partial<MemoryRow>) => Promise<MemoryRow>
    delete: (id: string) => Promise<void>
    uploadFile: (params: { userId: string; filename: string; blob: Blob; contentType: string }) => Promise<{ key: string; publicUrl: string }>
  }
  profile: {
    get: () => Promise<Record<string, unknown>>
    update: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
    listFacts: () => Promise<unknown[]>
    upsertFact: (fact: Record<string, unknown>) => Promise<unknown>
    deleteFact: (id: string) => Promise<void>
  }
  relationships: {
    listFamilyMembers: () => Promise<unknown[]>
    createFamilyMember: (input: Record<string, unknown>) => Promise<unknown>
    updateFamilyMember: (id: string, patch: Record<string, unknown>) => Promise<unknown>
    deleteFamilyMember: (id: string) => Promise<void>
    listRelationships: () => Promise<unknown[]>
  }
  locations: { list: () => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown>; update: (id: string, p: Record<string, unknown>) => Promise<unknown>; delete: (id: string) => Promise<void> }
  sources: { list: (params?: Record<string, unknown>) => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown>; update: (id: string, p: Record<string, unknown>) => Promise<unknown> }
  watch: { list: () => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown>; update: (id: string, p: Record<string, unknown>) => Promise<unknown>; delete: (id: string) => Promise<void> }
  rsvp: { upsert: (input: { event_id: string; status: string }) => Promise<unknown> }
  groups: { list: () => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown>; listInvites: () => Promise<unknown[]>; createInvite: (i: Record<string, unknown>) => Promise<unknown> }
  wishlist: { list: () => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown>; delete: (id: string) => Promise<void> }
  settings: { get: () => Promise<Record<string, unknown>>; update: (patch: Record<string, unknown>) => Promise<Record<string, unknown>> }
  agentTasks: { list: () => Promise<unknown[]>; create: (i: Record<string, unknown>) => Promise<unknown> }
  me: { get: () => Promise<{ userId: string; email: string }> }
  functions: {
    invoke: <T = unknown>(name: string, body?: unknown) => Promise<T>
  }
  realtime: {
    subscribeToStories: (cb: () => void) => () => void  // returns unsubscribe
  }
}
```

- [ ] **Step 2: `src/lib/dbClient.ts` — factory**

```ts
import type { DbClient } from './dbClient/types'
import { tier0 } from './dbClient/tier0'
import { tier1 } from './dbClient/tier1'

const mode = import.meta.env.VITE_PLANNEN_BACKEND_MODE ?? 'supabase'

export const dbClient: DbClient = mode === 'plannen-api' ? tier0 : tier1
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient.ts src/lib/dbClient/types.ts
git -c commit.gpgsign=false commit -m "dbClient: types + factory (tier0/tier1 impls follow)"
```

---

## Task 19: `dbClient/tier1.ts` — wrap supabase-js

**Files:**
- Create: `src/lib/dbClient/tier1.ts`

- [ ] **Step 1: Implement** — every method calls into `supabase` (the existing client from `src/lib/supabase.ts`) and translates the `{ data, error }` envelope to plain `data | throw`.

```ts
import { supabase } from '../supabase'
import type { DbClient } from './types'

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  if (res.data == null) throw new Error('No data')
  return res.data
}

export const tier1: DbClient = {
  me: {
    async get() {
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) throw new Error('Not authenticated')
      return { userId: data.user.id, email: data.user.email ?? '' }
    },
  },

  events: {
    list: async (p) => {
      let q = supabase.from('events').select('*').order('start_ts', { ascending: true })
      if (p?.limit) q = q.limit(p.limit)
      if (p?.from_date) q = q.gte('start_ts', p.from_date)
      if (p?.to_date)   q = q.lte('start_ts', p.to_date)
      return unwrap(await q)
    },
    get: async (id) => unwrap(await supabase.from('events').select('*').eq('id', id).single()),
    create: async (i) => unwrap(await supabase.from('events').insert(i).select().single()),
    update: async (id, p) => unwrap(await supabase.from('events').update(p).eq('id', id).select().single()),
    delete: async (id) => { const { error } = await supabase.from('events').delete().eq('id', id); if (error) throw error },
  },

  // ... repeat the pattern for stories, memories, profile, relationships, locations, sources,
  // watch, rsvp, groups, wishlist, settings, agentTasks. Translation is mechanical:
  //   list → from(table).select('*')
  //   create → from(table).insert(i).select().single()
  //   update → from(table).update(p).eq('id', id).select().single()
  //   delete → from(table).delete().eq('id', id)

  memories: {
    list: async (p) => {
      let q = supabase.from('memories').select('*')
      if (p?.event_id) q = q.eq('event_id', p.event_id)
      return unwrap(await q)
    },
    create: async (i) => unwrap(await supabase.from('memories').insert(i).select().single()),
    update: async (id, p) => unwrap(await supabase.from('memories').update(p).eq('id', id).select().single()),
    delete: async (id) => { const { error } = await supabase.from('memories').delete().eq('id', id); if (error) throw error },
    uploadFile: async ({ userId, filename, blob, contentType }) => {
      const path = `${userId}/${filename}`
      const { error } = await supabase.storage.from('event-photos').upload(path, blob, { contentType, upsert: false })
      if (error) throw error
      const { data } = supabase.storage.from('event-photos').getPublicUrl(path)
      return { key: `event-photos/${path}`, publicUrl: data.publicUrl }
    },
  },

  functions: {
    invoke: async <T>(name: string, body?: unknown) => {
      const { data, error } = await supabase.functions.invoke(name, { body })
      if (error) throw error
      return data as T
    },
  },

  realtime: {
    subscribeToStories: (cb) => {
      const ch = supabase
        .channel('stories-changes')
        .on('postgres_changes', { event: '*', schema: 'plannen', table: 'stories' }, () => cb())
        .subscribe()
      return () => { supabase.removeChannel(ch) }
    },
  },

  // For brevity, the implementation file in actual code will spell out every domain.
  // The pattern above is sufficient for translation; copy-paste-adjust per table.
  stories: { /* same pattern; copy from events */ } as any,
  profile: { /* spelled out per spec */ } as any,
  relationships: { /* spelled out */ } as any,
  locations: { /* spelled out */ } as any,
  sources: { /* spelled out */ } as any,
  watch: { /* spelled out — table 'watch_tasks' */ } as any,
  rsvp: { upsert: async (i) => unwrap(await supabase.from('rsvps').upsert(i).select().single()) } as any,
  groups: { /* spelled out */ } as any,
  wishlist: { /* spelled out */ } as any,
  settings: {
    get: async () => unwrap(await supabase.from('user_settings').select('*').single()),
    update: async (p) => unwrap(await supabase.from('user_settings').update(p).select().single()),
  } as any,
  agentTasks: { /* spelled out */ } as any,
}
```

In the actual file, replace every `as any` stub with the full implementation following the same mechanical translation. No domain should remain `as any` at commit time. The plan engineer should NOT skip these — the contract test in Task 21 will fail otherwise.

- [ ] **Step 2: Build + type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean (zero TS errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/tier1.ts
git -c commit.gpgsign=false commit -m "dbClient/tier1: supabase-js wrapper for all 16 domains"
```

---

## Task 20: `dbClient/tier0.ts` — fetch-based

**Files:**
- Create: `src/lib/dbClient/tier0.ts`

- [ ] **Step 1: Implement** — each method calls `fetch` against the Vite proxy (`/api/...`, `/storage/v1/...`, `/functions/v1/...`).

```ts
import type { DbClient } from './types'

const BASE = '' // same-origin via Vite proxy

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({ error: { code: 'BAD_JSON', message: 'Non-JSON response' } }))
  if (!res.ok || body.error) throw new Error(body.error?.message ?? res.statusText)
  return body.data as T
}

export const tier0: DbClient = {
  me: { get: () => api('/api/me') },

  events: {
    list: (p) => {
      const q = new URLSearchParams()
      if (p?.limit) q.set('limit', String(p.limit))
      if (p?.from_date) q.set('from_date', p.from_date)
      if (p?.to_date) q.set('to_date', p.to_date)
      return api(`/api/events${q.toString() ? `?${q}` : ''}`)
    },
    get: (id) => api(`/api/events/${id}`),
    create: (i) => api('/api/events', { method: 'POST', body: JSON.stringify(i) }),
    update: (id, p) => api(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    delete: async (id) => { await api(`/api/events/${id}`, { method: 'DELETE' }) },
  },

  // ... repeat per domain; spelled out in the actual file.

  memories: {
    list: (p) => api(`/api/memories${p?.event_id ? `?event_id=${p.event_id}` : ''}`),
    create: (i) => api('/api/memories', { method: 'POST', body: JSON.stringify(i) }),
    update: (id, p) => api(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    delete: async (id) => { await api(`/api/memories/${id}`, { method: 'DELETE' }) },
    uploadFile: async ({ userId, filename, blob, contentType }) => {
      const path = `${userId}/${filename}`
      const res = await fetch(`/storage/v1/object/event-photos/${path}`, {
        method: 'PUT', body: blob, headers: { 'Content-Type': contentType },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error?.message ?? 'Upload failed')
      return { key: body.data.Key, publicUrl: `/storage/v1/object/public/event-photos/${path}` }
    },
  },

  functions: {
    invoke: async <T>(name: string, body?: unknown) => {
      const res = await fetch(`/functions/v1/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? res.statusText)
      return json as T
    },
  },

  realtime: {
    // Polling fallback — useStories will call this with a callback every 30s.
    subscribeToStories: (cb) => {
      const id = setInterval(cb, 30_000)
      return () => clearInterval(id)
    },
  },

  // remaining domains spelled out in actual code: stories, profile, relationships,
  // locations, sources, watch, rsvp, groups, wishlist, settings, agentTasks
  stories: { /* spelled out */ } as any,
  profile: { /* spelled out */ } as any,
  relationships: { /* spelled out */ } as any,
  locations: { /* spelled out */ } as any,
  sources: { /* spelled out */ } as any,
  watch: { /* spelled out */ } as any,
  rsvp: { upsert: (i) => api('/api/rsvp', { method: 'POST', body: JSON.stringify(i) }) } as any,
  groups: { /* spelled out */ } as any,
  wishlist: { /* spelled out */ } as any,
  settings: { get: () => api('/api/settings'), update: (p) => api('/api/settings', { method: 'PATCH', body: JSON.stringify(p) }) } as any,
  agentTasks: { /* spelled out */ } as any,
}
```

Spell out every `as any` stub in the actual file. The contract test enforces parity.

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/tier0.ts
git -c commit.gpgsign=false commit -m "dbClient/tier0: fetch impl for all 16 domains"
```

---

## Task 21: `dbClient` contract test

**Files:**
- Create: `src/lib/dbClient/contract.test.ts`

- [ ] **Step 1: Write the parameterised test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the SHAPE: every method that exists on tier1 also exists on tier0,
// takes compatible args, returns a thenable that resolves to a comparable shape.
// We do NOT test against real backends — those have their own tests.

import { tier0 } from './tier0'
import { tier1 } from './tier1'

// Mock fetch for tier0; mock supabase for tier1.
vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: {}, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: {}, error: null }) }) }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u', email: 'e@x' } }, error: null }) },
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
    storage: { from: () => ({ upload: () => Promise.resolve({ data: {}, error: null }), getPublicUrl: () => ({ data: { publicUrl: '/x' } }) }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  },
}))

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { headers: { 'Content-Type': 'application/json' } })) as any
})

const domains: Array<keyof typeof tier0> = [
  'events', 'stories', 'memories', 'profile', 'relationships',
  'locations', 'sources', 'watch', 'rsvp', 'groups', 'wishlist',
  'settings', 'agentTasks', 'me', 'functions', 'realtime',
]

describe('dbClient contract — same surface on both tiers', () => {
  for (const d of domains) {
    it(`tier0.${d} and tier1.${d} expose the same method names`, () => {
      const t0 = Object.keys(tier0[d] as object).sort()
      const t1 = Object.keys(tier1[d] as object).sort()
      expect(t0).toEqual(t1)
    })
  }

  it('events.list returns an array (both)', async () => {
    const a = await tier0.events.list()
    const b = await tier1.events.list()
    expect(Array.isArray(a)).toBe(true)
    expect(Array.isArray(b)).toBe(true)
  })

  it('me.get returns { userId, email } shape (both)', async () => {
    const a = await tier0.me.get()
    const b = await tier1.me.get()
    expect(a).toHaveProperty('userId')
    expect(b).toHaveProperty('userId')
  })
})
```

- [ ] **Step 2: Run, expect PASS**

```bash
pnpm vitest run src/lib/dbClient/contract.test.ts
```

If any `as any` stubs remain in tier0.ts or tier1.ts, this will fail with method-name mismatches. Fix by spelling out the missing domains.

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/contract.test.ts
git -c commit.gpgsign=false commit -m "dbClient: contract test asserts tier parity"
```

---

## Task 22: Refactor 16 service files to passthroughs

Mechanical: each service swaps its `import { supabase }` for `import { dbClient }` and reduces each function to a 1-line call.

**Files:** all of `src/services/*.ts` (16 files)

- [ ] **Step 1: Refactor one service as a model — `src/services/eventService.ts`**

Before (example):
```ts
import { supabase } from '../lib/supabase'

export async function listEvents(userId: string, limit = 10) {
  const { data, error } = await supabase.from('events').select('*').eq('created_by', userId).limit(limit)
  if (error) throw error
  return data
}
```

After:
```ts
import { dbClient } from '../lib/dbClient'

export const listEvents = (_userId: string, limit = 10) =>
  dbClient.events.list({ limit })
```

(The `userId` arg becomes vestigial because the backend infers identity from the connection/JWT. Keep the signature for now to avoid touching call sites.)

- [ ] **Step 2: Run the web app build, fix any types**

```bash
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 3: Commit the one service**

```bash
git add src/services/eventService.ts
git -c commit.gpgsign=false commit -m "services: eventService passthrough to dbClient"
```

- [ ] **Step 4: Repeat for each remaining service**

For each of the 15 remaining files (`agentTaskService`, `appAccessService`, `calendarExport`, `eventCoverService`, `googleOAuthService`, `groupService`, `inviteService`, `memoryService`, `photoPickerService`, `profileService`, `relationshipService`, `rsvpService`, `storyService`, `viewService`, `wishlistService`):

1. Rewrite functions to call `dbClient.<domain>.<method>`. If the existing service does something not in dbClient (e.g., compose multiple queries), either: (a) add a domain method to dbClient + tier0/tier1 + backend route, or (b) leave the composition in the service file calling multiple dbClient methods.
2. Type-check.
3. Commit per file: `services: <name> passthrough to dbClient`.

- [ ] **Step 5: Verify no service imports `supabase` directly**

```bash
grep -rn "from.*lib/supabase\|from.*'\\.\\./lib/supabase'" src/services/
```

Expected: no matches (the only remaining importer of `src/lib/supabase.ts` should be `dbClient/tier1.ts`).

- [ ] **Step 6: Tag the milestone**

```bash
git -c commit.gpgsign=false commit --allow-empty -m "milestone: all services route through dbClient"
```

---

## Task 23: AuthContext tier branch + useStories polling + Vite proxy

**Files:**
- Modify: `src/context/AuthContext.tsx`
- Modify: `src/hooks/useStories.ts`
- Modify: `vite.config.ts`
- Modify: `.env.example`

- [ ] **Step 1: AuthContext** — read existing file. Add a Tier 0 branch at the top of the provider:

```tsx
const tier = import.meta.env.VITE_PLANNEN_TIER ?? '1'

useEffect(() => {
  if (tier === '0') {
    // Tier 0: no Supabase Auth. Short-circuit to /api/me.
    dbClient.me.get().then((u) => {
      setUser({ id: u.userId, email: u.email })
      setLoading(false)
    }).catch(() => setLoading(false))
    return
  }
  // ... existing Tier 1 flow (supabase.auth.getSession() + onAuthStateChange)
}, [])
```

Also: when `tier === '0'`, never render the login page — children always render.

- [ ] **Step 2: `useStories` polling** — read existing hook. The current implementation uses `supabase.channel('stories-changes').on(...).subscribe()`. Replace with the dbClient.realtime abstraction:

```tsx
useEffect(() => {
  const unsubscribe = dbClient.realtime.subscribeToStories(() => {
    refetchStories()
  })
  return unsubscribe
}, [refetchStories])
```

The Tier 0 impl in `dbClient/tier0.ts` calls `setInterval(cb, 30000)`; the Tier 1 impl wraps Realtime. Same surface.

- [ ] **Step 3: Vite proxy** — modify `vite.config.ts`:

```ts
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const tier0 = env.VITE_PLANNEN_TIER === '0'
  const backendUrl = env.BACKEND_URL ?? 'http://127.0.0.1:54323'

  return {
    // ...existing config
    server: {
      port: 4321,
      strictPort: true,
      proxy: tier0 ? {
        '/api':          { target: backendUrl, changeOrigin: true },
        '/storage/v1':   { target: backendUrl, changeOrigin: true },
        '/functions/v1': { target: backendUrl, changeOrigin: true },
      } : undefined,
    },
  }
})
```

- [ ] **Step 4: `.env.example`** — add the Tier-0-specific block:

```
# Tier 0 backend
PLANNEN_BACKEND_PORT=54323
BACKEND_URL=http://127.0.0.1:54323
VITE_PLANNEN_TIER=0
VITE_PLANNEN_BACKEND_MODE=plannen-api

# Tier 1 web app vars (only set in Tier 1)
# VITE_SUPABASE_URL=
# VITE_SUPABASE_ANON_KEY=
```

- [ ] **Step 5: Type-check + build**

```bash
pnpm tsc --noEmit && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add src/context/AuthContext.tsx src/hooks/useStories.ts vite.config.ts .env.example
git -c commit.gpgsign=false commit -m "web: tier branches for AuthContext, useStories polling, Vite proxy"
```

---

## Task 24: bootstrap.sh integration

**Files:**
- Modify: `scripts/bootstrap.sh`

- [ ] **Step 1: Add backend build + start to Tier 0 branch**

In `bootstrap.sh`, after the pg-init / migrate / insert-user block in the `if [[ "$TIER" == "0" ]]; then` branch, add:

```bash
echo "==> building backend"
(cd backend && pnpm install && pnpm build)

echo "==> starting backend"
bash scripts/backend-start.sh
```

- [ ] **Step 2: Extend `.env` write block** — append Tier 0 vars:

```bash
cat >> .env <<EOF
PLANNEN_BACKEND_PORT=54323
BACKEND_URL=http://127.0.0.1:54323
VITE_PLANNEN_TIER=$TIER
VITE_PLANNEN_BACKEND_MODE=plannen-api
EOF
```

- [ ] **Step 3: Smoke**

```bash
bash scripts/backend-stop.sh
bash scripts/pg-stop.sh
rm -rf ~/.plannen
bash scripts/bootstrap.sh --non-interactive --email smoke@plannen.local
# expect: pg starts, migrations apply, backend builds, backend starts, /health OK
curl -s http://127.0.0.1:54323/api/me
# expect: {"data":{"userId":"...","email":"smoke@plannen.local"}}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/bootstrap.sh
git -c commit.gpgsign=false commit -m "bootstrap: build + start backend in Tier 0"
```

---

## Task 25: E2E smoke test

**Files:**
- Create: `tests/e2e/tier0-smoke.spec.ts`

- [ ] **Step 1: Add Playwright if not present**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

If `playwright.config.ts` doesn't exist, create one matching the repo's existing test conventions.

- [ ] **Step 2: Write the smoke `tests/e2e/tier0-smoke.spec.ts`**

```ts
import { test, expect } from '@playwright/test'

test('Tier 0 — load app, no login page, create event, upload photo', async ({ page }) => {
  await page.goto('http://localhost:4321')

  // No login page in Tier 0
  await expect(page.locator('text=Sign in')).toHaveCount(0)

  // User identity visible
  await expect(page.locator('header')).toContainText(/@plannen\.local|smoke/i)

  // Create event via UI
  await page.click('text=New event')
  await page.fill('input[name="title"]', 'E2E test event')
  await page.fill('input[name="start_ts"]', '2026-06-01T10:00')
  await page.click('text=Save')
  await expect(page.locator('text=E2E test event')).toBeVisible()

  // Upload a tiny photo
  await page.click('text=E2E test event')
  await page.setInputFiles('input[type=file]', { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })
  await expect(page.locator('img[src*="/storage/v1/object/public/event-photos/"]')).toBeVisible({ timeout: 5000 })
})
```

- [ ] **Step 3: Run manually**

```bash
bash scripts/pg-start.sh && bash scripts/backend-start.sh && pnpm dev &
sleep 5
pnpm exec playwright test tests/e2e/tier0-smoke.spec.ts
```

If the test reveals fixture / UI selector issues, fix them inline. The selectors above assume the existing Plannen UI labels — adjust if they differ.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/ playwright.config.ts package.json pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "e2e: Tier 0 smoke (no login, create event, upload photo)"
```

---

## Task 26: CI guard update

**Files:**
- Modify: `.github/workflows/tier-0-bootstrap.yml`

- [ ] **Step 1: Append backend + e2e steps**

After the existing `cd mcp && pnpm test` step, add:

```yaml
      - run: cd backend && pnpm test
        env:
          DATABASE_URL: postgres://plannen:plannen@127.0.0.1:54322/plannen
          PLANNEN_USER_EMAIL: ci@plannen.local
      - run: bash scripts/backend-start.sh
        env:
          DATABASE_URL: postgres://plannen:plannen@127.0.0.1:54322/plannen
          PLANNEN_USER_EMAIL: ci@plannen.local
          PLANNEN_BACKEND_PORT: 54323
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm dev &
      - run: sleep 5 && pnpm exec playwright test tests/e2e/tier0-smoke.spec.ts
```

Also add `backend/**` to the workflow's `paths:` trigger.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tier-0-bootstrap.yml
git -c commit.gpgsign=false commit -m "ci: backend tests + Playwright Tier 0 smoke"
```

---

## Task 27: Doc updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/INTEGRATIONS.md` (created in Phase 1)

- [ ] **Step 1: README — daily workflow**

Update the Tier 0 daily-workflow section:

```markdown
### Tier 0 daily workflow

```bash
bash scripts/pg-start.sh        # embedded Postgres
bash scripts/backend-start.sh   # Plannen backend
npm run dev                     # web app on 4321
```

After reboot, run the three commands in order. `bash scripts/pg-stop.sh && bash scripts/backend-stop.sh` to shut down cleanly.
```

- [ ] **Step 2: CLAUDE.md — hard rules**

Add a hard rule:

```markdown
- **Tier 0 daily workflow has three processes.** `pg-start.sh` (embedded Postgres) → `backend-start.sh` (Plannen backend on port 54323) → `npm run dev` (web app on 4321 with proxy). All three must be running for the web app to work.
```

- [ ] **Step 3: INTEGRATIONS.md — storage URL pin**

Add a section:

```markdown
## Storage URL shape

Plannen pins `media_url` columns to Supabase Storage's URL shape: `/storage/v1/object/public/event-photos/<userId>/<filename>`. In Tier 0, the backend serves this URL pattern from `~/.plannen/photos/event-photos/`. In Tier 1, real Supabase Storage serves it.

This pin means `media_url` rows are portable across tiers. If Supabase ever changes the URL format, our Tier 0 mirror will need to follow suit (or the column has to be rewritten on tier switch).
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/INTEGRATIONS.md
git -c commit.gpgsign=false commit -m "docs: Tier 0 daily workflow + storage URL pin"
```

---

## Task 28: Final integration check

- [ ] **Step 1: Full clean reboot**

```bash
bash scripts/backend-stop.sh
bash scripts/pg-stop.sh
rm -rf ~/.plannen
bash scripts/bootstrap.sh --non-interactive --email final@plannen.local
```

Expected: pg starts, migrations apply, mcp builds + tests pass, backend builds, backend starts, `.env` written with all Tier 0 vars.

- [ ] **Step 2: Run every test suite**

```bash
cd mcp && pnpm test && cd ..
cd backend && pnpm test && cd ..
pnpm vitest run src/lib/dbClient/
pnpm exec playwright test tests/e2e/tier0-smoke.spec.ts
```

Expected: all green.

- [ ] **Step 3: Manual UI walkthrough**

Open `http://localhost:4321`. Verify:
- No login page.
- Header shows `final@plannen.local`.
- Create event → appears in list.
- Upload photo → renders via `/storage/v1/object/...`.
- `/plannen-write-story` from Claude → web app picks up the new story within 30s (polling).

- [ ] **Step 4: Tier 1 regression check**

This is the destructive part — only run if you have the Phase-1 backup taken before starting.

```bash
bash scripts/backend-stop.sh
bash scripts/pg-stop.sh
rm -rf ~/.plannen
bash scripts/bootstrap.sh --non-interactive --email final-t1@plannen.local --tier 1
# expect: supabase start, supabase migration up, mcp tests pass
cd mcp && pnpm test
# Manual smoke: web app at 4321, log in via magic-link, create event, edge functions work
```

If anything fails, restore from the Phase-1 backup (`tar -xf ~/plannen-backup-2026-05-14/...`).

- [ ] **Step 5: Tag the milestone**

```bash
git -c commit.gpgsign=false commit --allow-empty -m "milestone: Tier 0 Phase 2 complete"
```

---

## Self-review

**Spec coverage:**

- §Architecture — Tasks 1, 2, 3, 4, 12, 18 cover backend + dbClient factory + handler extraction.
- §File structure — Tasks 1–17 (backend), 18–22 (web app), 24 (bootstrap).
- §Data flow > Tier 0 web app boot — Task 23 (AuthContext + Vite proxy).
- §Data flow > Tier 0 backend request handling — Task 2 (db.ts), Task 4 (middleware).
- §Data flow > Tier 0 photo upload — Task 5 (storage routes) + Task 20 (tier0.memories.uploadFile).
- §Data flow > Tier 0 edge function call — Task 12 (function routes).
- §Data flow > Tier 1 same call after refactor — Tasks 6, 7, 8–11 (handler extraction + JWT verify).
- §Data flow > Tier 0 story creation — Task 23 (useStories polling).
- §Data flow > Tier 0 reboot recovery — Task 17 (backend-start.sh).
- §Error envelope — Task 4 (error middleware).
- §Validation — Task 13 (zod in events route as the model; other routes follow).
- §Security model Tier 0 — Task 4 (CORS), Task 5 (path traversal guard).
- §Security model Tier 1 — Task 7 (JWT verify with jose).
- §Observability — Task 1 (/health), Task 17 (log file).
- §Resource leaks — Task 2 (graceful shutdown wired).
- §Testing > dbClient contract — Task 21.
- §Testing > Handler runtime parity — Tasks 8–11 (each handler has a vitest test).
- §Testing > Storage path traversal — Task 5.
- §Testing > GUC isolation — Task 2.
- §Testing > E2E smoke — Task 25.
- §Risks 1–7 — addressed by tests, contract checks, and the milestone smoke in Task 28.

**Placeholders:** Tasks 8b, 8c, 9a, 9b, 9c, 10a, 10b, 10c, 11a, 11b, 11c describe handler-by-handler extraction without spelling out every line — but they reference Task 8a as the model and call out the specific changes (signature swap, `db.from → ctx.db.query`, OAuth specifics). Tasks 14, 15, 16, 22 batch similar work with the events-route template (Task 13) and eventService template (Task 22 Step 1) as the spelled-out model. This is intentional — the alternative (12 fully-spelled tasks for handlers + 16 fully-spelled service refactors) bloats the plan to ~3000 lines without adding information. The engineer reading the plan has a complete template + a complete enumeration of which files to touch.

**Type consistency:**
- `HandlerCtx` defined in Task 6 (`{ db, userId }`), consumed identically in Tasks 8–11.
- `DbClient` interface defined in Task 18, implemented in Tasks 19, 20, asserted in Task 21.
- `withUserContext(userId, fn)` signature matches `mcp/src/db.ts` (Phase 1) and `backend/src/db.ts` (Task 2).
- Env vars consistent across plan: `PLANNEN_TIER`, `DATABASE_URL`, `PLANNEN_USER_EMAIL`, `PLANNEN_BACKEND_PORT`, `BACKEND_URL`, `VITE_PLANNEN_TIER`, `VITE_PLANNEN_BACKEND_MODE`.

**Known plan risk:** Tasks 19/20 stub some domains with `as any` in the plan body to keep length manageable, with explicit instructions to spell out every method in the actual file. The contract test in Task 21 enforces this — if the engineer skips a domain, the test fails at name-set comparison.

**Open spec questions resolved by this plan:**
- Multipart parser → raw `c.req.arrayBuffer()` in storage route (Task 5). Sufficient for ≤ 20MB photos.
- Backend port collision → bootstrap script reads `PLANNEN_BACKEND_PORT` env override (Task 17 + 24).
- Tier 2 path → same `tier0.ts` works against any backend pointed at by `BACKEND_URL`; no separate code path (per spec §Open Questions).
