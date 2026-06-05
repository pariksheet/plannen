# Plannen Tier 0 — Phase 2 Design

**Date:** 2026-05-14
**Status:** Design approved; pending implementation plan
**Branch:** `feat/postgres_decoupled`
**Companion to:** [`2026-05-14-plannen-storage-tiers-design.md`](./2026-05-14-plannen-storage-tiers-design.md), [`2026-05-14-plannen-tier-0-phase-1.md`](../plans/2026-05-14-plannen-tier-0-phase-1.md)

## Context

Phase 1 ships the Tier 0 starter for the **MCP / Claude path only**: embedded Postgres, migration runner, `pg.Pool` + GUC identity, Tier-0 SQL overlay, and a `bootstrap.sh --tier` flag. The web app stays Tier-1-only in Phase 1; tools that hit edge functions (photo picker, transcription, AI agents) return clean "requires Tier 1" errors.

Phase 2 closes that gap. It stands up a Node/Hono backend at `backend/` that mirrors Supabase's 12 edge functions + storage + REST surface, refactors the web app to route through a `dbClient` factory that picks per-tier, and changes `AuthContext` to short-circuit in Tier 0 (no login page, no Mailpit). After Phase 2 lands, a new user runs `bash scripts/bootstrap.sh` with Node 20+ and gets the full web app working against embedded Postgres — no Docker, no Supabase CLI.

Phase 2 also opportunistically unifies data access: the 12 edge functions today use `@supabase/supabase-js` with JWT-scoped RLS; under Phase 2 they get refactored to verify JWT explicitly and use `pg.Pool` with the GUC pattern. The same pure handler runs under both Deno (Tier 1) and Node (Tier 0), eliminating two data-access patterns from the codebase.

## Goals & non-goals

### Goals

- **Web app works against Tier 0** with the same daily workflow as Tier 1 (`npm run dev`, log in once, use the app).
- **Single shared handler per edge function** — `_shared/handlers/<name>.ts` exporting `handle(req, ctx)` runs identically on Deno (Tier 1) and Node (Tier 0).
- **One factory toggles the web app's backend** — `src/lib/dbClient.ts` picks the impl from `VITE_PLANNEN_BACKEND_MODE`; service files become thin pass-throughs.
- **Tier 1 keeps working** end-to-end. The wire contract between web app and Supabase (PostgREST, Storage, Auth, Functions) is unchanged from the user's perspective; only the implementation inside each edge function changes.
- **Storage URL shape matches Supabase** so `media_url` rows are portable across tiers — no per-tier URL rewriting.
- **AuthContext is tier-aware** without leaking tier checks into every consumer. Components keep calling `useAuth()`; the context handles the Tier 0 short-circuit internally.
- **The single Realtime subscription** (`useStories.ts`) degrades cleanly to 30s polling in Tier 0.

### Non-goals

- **Tier 3+ hosted Plannen.** The architecture must not preclude it; building it is out of scope.
- **Multi-user / multi-tenant.** GUC stays a single-user identity, not a security boundary.
- **SSE / WebSocket Realtime in Tier 0.** Polling is the final answer for this phase.
- **Replacing `@supabase/supabase-js` from the Tier 1 web app.** Kept; `dbClient/tier1.ts` wraps it.
- **Replacing Supabase Storage in Tier 1.** Tier 0 mirrors the URL shape; Tier 1 still uses real Supabase Storage.
- **Kitchen plugin updates.** Phase 1 deferred these; Phase 2 inherits that deferral.
- **Hot-reload of backend on file change.** Manual restart for now.
- **Tier 1 manual-smoke automation in CI.** Existing CI already covers Tier 1 via the MCP integration suite.

## Architecture

Phase 2 adds a Node/Hono process at `backend/` (sibling of `mcp/`) that serves three URL spaces in Tier 0:

- `/api/*` — Plannen REST surface (events, memories, stories, profile, etc.)
- `/storage/v1/object/event-photos/*` — Supabase-compatible photo serving from `~/.plannen/photos/`
- `/functions/v1/<name>` — Hono mounts of the 12 mirrored edge functions

The 12 edge functions in `supabase/functions/` get refactored: their logic moves to `supabase/functions/_shared/handlers/<name>.ts` exporting `async function handle(req: Request, ctx: { db, userId }): Promise<Response>`. The Deno entry shrinks to `Deno.serve` + JWT-verify-then-call-handler. The Node entry is a Hono mount that calls the same handler.

The web app gets a new factory at `src/lib/dbClient.ts`. Tier 1 wraps `@supabase/supabase-js`; Tier 0 uses `fetch`. All 16 service files in `src/services/` become thin pass-throughs to `dbClient`. `AuthContext` checks `VITE_PLANNEN_TIER`; Tier 0 short-circuits to the configured user via `GET /api/me` and never renders the login page.

`useStories` keeps its Realtime subscription in Tier 1 and falls back to 30s polling in Tier 0.

```
                  ┌─────────────────────────────────┐
   web app  ──→   │  src/lib/dbClient.ts (factory)  │
   (4321)         └────────┬──────────────┬─────────┘
                           │ Tier 1       │ Tier 0/2
                           ↓              ↓
                   supabase-js      fetch BACKEND_URL
                           │              │
                           │              ↓
                           │     ┌────────────────────┐
                           │     │  backend/ (Hono)   │
                           │     │  port 54323        │
                           │     │                    │
                           │     │  /api/*            │
                           │     │  /storage/v1/*     │
                           │     │  /functions/v1/*   │
                           │     └────┬───────────────┘
                           │          │
                           ↓          ↓
                  ┌──────────────────────────┐
                  │  Postgres (any tier)     │
                  │  via pg.Pool + GUC       │
                  └──────────────────────────┘

   Claude / MCP ─→ pg.Pool (Phase 1)
```

## File structure

### New `backend/` package

```
backend/
├── package.json                       deps: hono, @hono/node-server, pg, zod, jose
├── tsconfig.json
└── src/
    ├── index.ts                       Hono bootstrap; mounts route groups; listens on PLANNEN_BACKEND_PORT (54323)
    ├── db.ts                          pg.Pool + withUserContext (shares pattern with mcp/src/db.ts)
    ├── auth.ts                        Tier 0: read PLANNEN_USER_ID from env. Tier 1 path: JWT verify (future)
    ├── middleware/
    │   ├── userContext.ts             Sets c.var.userId from auth.ts; rejects with 401 if missing
    │   └── error.ts                   JSON error envelope
    ├── routes/
    │   ├── api/                       Plannen REST surface
    │   │   ├── me.ts                  GET /api/me → { userId, email }
    │   │   ├── events.ts              GET/POST/PATCH/DELETE /api/events[/:id]
    │   │   ├── memories.ts            GET /api/memories; POST /api/memories (multipart upload)
    │   │   ├── stories.ts             GET/POST/PATCH/DELETE /api/stories[/:id]
    │   │   ├── profile.ts             GET/PATCH /api/profile/*; profile-facts CRUD
    │   │   ├── relationships.ts       GET/POST /api/family-members, /api/relationships
    │   │   ├── locations.ts           GET/POST /api/locations
    │   │   ├── sources.ts             GET/POST /api/sources
    │   │   ├── watch.ts               watch_tasks CRUD
    │   │   ├── rsvp.ts                rsvp event endpoint
    │   │   ├── groups.ts              groups + invites
    │   │   ├── wishlist.ts            wishlist CRUD
    │   │   ├── settings.ts            GET/PATCH /api/settings (BYOK key, etc.)
    │   │   └── agent-tasks.ts         GET/POST /api/agent-tasks
    │   ├── storage/
    │   │   └── eventPhotos.ts         GET/PUT/DELETE /storage/v1/object/event-photos/:path → ~/.plannen/photos/event-photos/
    │   └── functions/                 thin wrappers around _shared/handlers
    │       ├── agentDiscover.ts       app.all('/functions/v1/agent-discover', c => handle(c.req.raw, ctx))
    │       ├── agentExtractImage.ts
    │       ├── agentScrape.ts
    │       ├── agentTest.ts
    │       ├── getGoogleAccessToken.ts
    │       ├── getGoogleAuthUrl.ts
    │       ├── googleOauthCallback.ts
    │       ├── memoryImage.ts
    │       ├── pickerSessionCreate.ts
    │       ├── pickerSessionPoll.ts
    │       ├── sendInviteEmail.ts
    │       └── sendReminder.ts
    └── deno-shim.d.ts                 ambient types so the cross-runtime handlers compile under Node tsc
```

### Refactored `supabase/functions/_shared/`

```
supabase/functions/
├── _shared/
│   ├── ai.ts                          refactored: takes a `db` arg instead of importing supabase-js; public function names preserved
│   ├── googleOAuth.ts                 unchanged
│   └── handlers/                      NEW — pure, runtime-agnostic
│       ├── agent-discover.ts          export async function handle(req, ctx)
│       ├── agent-extract-image.ts
│       ├── agent-scrape.ts
│       ├── agent-test.ts
│       ├── get-google-access-token.ts
│       ├── get-google-auth-url.ts
│       ├── google-oauth-callback.ts
│       ├── memory-image.ts
│       ├── picker-session-create.ts
│       ├── picker-session-poll.ts
│       ├── send-invite-email.ts
│       └── send-reminder.ts
└── <function-name>/index.ts           shrinks to: Deno.serve(req => handle(req, { db: pgClient, userId: jwtVerify(req) }))
```

### Web app changes

```
src/
├── lib/
│   ├── supabase.ts                    KEPT — still used by Tier 1 dbClient impl
│   ├── dbClient.ts                    NEW — factory: picks impl from VITE_PLANNEN_BACKEND_MODE
│   └── dbClient/
│       ├── types.ts                   shared interface (events.list, memories.upload, …)
│       ├── tier1.ts                   wraps supabase-js
│       └── tier0.ts                   fetch BACKEND_URL
├── context/AuthContext.tsx            adds tier branch — Tier 0 calls GET /api/me, no login page
├── hooks/useStories.ts                tier-branch: Tier 1 .subscribe(), Tier 0 setInterval poll
└── services/*.ts                      16 files become 1-line passthroughs: `export const listEvents = (...) => dbClient.events.list(...)`
```

### New scripts

```
scripts/
├── backend-start.sh                   wraps `node backend/dist/index.js`; PID at ~/.plannen/backend.pid
└── backend-stop.sh
```

### Vite proxy

`vite.config.ts` proxies `/api`, `/storage/v1`, `/functions/v1` to `BACKEND_URL` when `PLANNEN_TIER=0`.

## Data flow

### Tier 0 web app boot

1. Vite reads `VITE_PLANNEN_BACKEND_MODE=plannen-api` from `.env`, starts on `4321`, proxies `/api/*`, `/storage/v1/*`, `/functions/v1/*` to `BACKEND_URL` (`http://127.0.0.1:54323`).
2. App mounts. `AuthContext` checks `import.meta.env.VITE_PLANNEN_TIER`. Tier 0: skips Supabase Auth entirely, calls `GET /api/me`, receives `{ userId, email }`, sets context.
3. `dbClient` factory checks `VITE_PLANNEN_BACKEND_MODE`. Tier 0: returns the fetch-based impl.
4. Components render. Service calls (`listEvents()`) → `dbClient.events.list()` → `fetch('/api/events?...')` → Vite proxy → `backend/` → `pg.Pool` → embedded Postgres.

### Tier 0 backend request handling

1. Hono receives request.
2. `middleware/userContext` reads `PLANNEN_USER_ID` from env (set once at process start by reading `plannen.users WHERE email = PLANNEN_USER_EMAIL`), attaches to `c.var.userId`. No JWT verification, no per-request DB lookup for identity.
3. Route handler opens a pg client via `withUserContext(c.var.userId, async db => ...)`. `set_config('app.current_user_id', userId, true)` runs inside the transaction; `auth.uid()` in RLS policies resolves correctly.
4. Handler returns JSON / multipart / file stream. Hono serializes to Response.

### Tier 0 photo upload

1. Web: `memoryService.upload(file)` → `dbClient.memories.upload(file)` → `POST /storage/v1/object/event-photos/<userId>/<filename>` (multipart).
2. Backend `routes/storage/eventPhotos.ts`: streams body to `~/.plannen/photos/event-photos/<userId>/<filename>`. No DB write.
3. Backend returns `{ Key: 'event-photos/<userId>/<filename>' }` matching Supabase Storage's response shape.
4. Web: stores `media_url = '/storage/v1/object/public/event-photos/<userId>/<filename>'` in `plannen.memories`.
5. Render time: `<img src={media_url}>` resolves to `http://127.0.0.1:4321/storage/v1/...` → Vite proxy → backend → reads file from `~/.plannen/photos/...` → streams response.

### Tier 0 edge function call (e.g. `agent-discover`)

1. Web: `useAgent` → `dbClient.functions.invoke('agent-discover', { query })` → `POST /functions/v1/agent-discover`.
2. Vite proxies to backend `routes/functions/agentDiscover.ts`.
3. Wrapper calls `handle(c.req.raw, { db: pool, userId: c.var.userId })` from `_shared/handlers/agent-discover.ts`.
4. Handler reads `plannen.user_settings` for the BYOK key via `db.query(...)`, calls Anthropic API, returns JSON Response. Hono passes through.

### Tier 1 same call (after refactor)

1. Web: `useAgent` → `dbClient.functions.invoke('agent-discover', ...)` → Tier 1 impl calls `supabase.functions.invoke('agent-discover', ...)`.
2. Supabase Edge Runtime serves `supabase/functions/agent-discover/index.ts`.
3. Deno entry verifies JWT against Supabase JWKS, opens pg client with GUC, calls the same `_shared/handlers/agent-discover.ts` handler.
4. Handler runs identically. Response returned.

### Tier 0 story creation (write + polling refresh)

1. Claude path: `mcp__plannen__create_story` → MCP `withUserContext(userId)` → pg INSERT. (Phase 1 path.)
2. Web app: `useStories` polls `GET /api/stories?limit=50` every 30s. Detects new row, re-renders.
3. No Realtime. No SSE.

### Tier 0 reboot recovery

1. User boots Mac. Nothing running.
2. `bash scripts/pg-start.sh` → embedded Postgres comes up.
3. `bash scripts/backend-start.sh` → Hono process comes up, queries `plannen.users` once for `PLANNEN_USER_ID`, ready.
4. `npm run dev` → web app reachable at `localhost:4321`.

## Error handling, security, observability

### Error envelope

Backend returns a uniform JSON shape so the web app's existing error-handling code works without per-tier branches:

```ts
// Success: { data: T }
// Error:   { error: { code: string, message: string, hint?: string } }
```

`middleware/error.ts` catches uncaught errors, logs with stack, returns `{ error: { code: 'INTERNAL', message: <safe-message> } }` at 500. Known errors (validation, not-found, unauthorized) get specific codes (`VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`) and proper status. The Tier 1 supabase-js adapter inside `dbClient/tier1.ts` translates Supabase's `{ data, error }` envelope to the same shape so consumers see one error format.

### Validation

Each route validates input via `zod` at the boundary. Failed validation → 400 with `{ error: { code: 'VALIDATION', message, hint: zodIssuesToString } }`. The same zod schemas live next to the route handlers; pure handlers in `_shared/handlers/*` validate their own inputs (so Tier 1 edge functions get the same validation).

### Security model (Tier 0)

- Backend binds to `127.0.0.1` only — never `0.0.0.0`. No exposure beyond loopback.
- No auth tokens, no JWT verification. The threat model assumes anyone with access to your machine has access to your data — same as Tier 1 with the local service role key sitting in `.env`.
- CORS: backend allows only `http://localhost:4321` and `http://127.0.0.1:4321` for browser-originated requests; rejects others.
- RLS stays enabled in Postgres as defence-in-depth. The GUC-driven `auth.uid()` ensures policies still evaluate correctly even though there's only one user.
- File uploads to `/storage/v1/object/event-photos/*` are path-traversal-guarded (`path.resolve` + prefix check against the photos root).

### Security model (Tier 1 edge functions after refactor)

- Each Deno entry verifies the JWT in `Authorization: Bearer <token>` against Supabase's JWKS using `jose` before extracting `userId`.
- If the token is missing/invalid/expired → 401 immediately, handler never runs.
- Verified `userId` is passed to the pure handler. Inside, the pg client is opened with `withUserContext(userId)` — RLS still enforces row-level isolation.
- `_shared/handlers/*` never trust a userId from the request body; it comes only from JWT or backend env.

### Observability

- Backend logs every request as one line: `<method> <path> <status> <duration_ms>`. Stdout, captured by `~/.plannen/backend.log` via the bash launch script.
- Errors include stack traces (Tier 0 is local; no PII concern).
- `GET /health` returns `{ status: 'ok', tier: '0', dbConnected: true }` for the bash scripts to probe before declaring "ready".
- No external telemetry, no metrics endpoint in Phase 2.

### Resource leaks / shutdown

- Hono process traps `SIGTERM`/`SIGINT`, closes the pg.Pool with `await pool.end()`, deletes its pidfile.
- File-stream uploads to storage use `pipeline()` so partial uploads on disconnect don't leak open file handles.

## Testing strategy

### Test boundaries

| Layer | Test type | Location | Runner |
|---|---|---|---|
| `_shared/handlers/*` pure handlers | Unit (per handler, both happy + error paths) | `supabase/functions/_shared/handlers/<name>.test.ts` | vitest |
| `backend/src/routes/*` Hono routes | Integration (Hono `fetch` API + real pg) | `backend/src/routes/**/*.test.ts` | vitest |
| `backend/src/db.ts`, `auth.ts` | Unit | `backend/src/**/*.test.ts` | vitest |
| `src/lib/dbClient/*` | Unit per tier (mock fetch for Tier 0, mock supabase-js for Tier 1) | `src/lib/dbClient/*.test.ts` | vitest |
| `src/lib/dbClient` contract | Contract test — both tier impls satisfy the same interface against an in-memory expectation table | `src/lib/dbClient/contract.test.ts` | vitest |
| `src/services/*` | Skip — they're 1-line passthroughs after refactor | — | — |
| `src/context/AuthContext.tsx` Tier 0 path | Component test — mounts AuthContext with mocked `/api/me`, asserts no login page rendered, user available in context | `src/context/AuthContext.test.tsx` | vitest + testing-library |
| `src/hooks/useStories.ts` polling | Hook test — fake timers, assert refetch every 30s in Tier 0; no refetch in Tier 1 (only Realtime callback) | `src/hooks/useStories.test.ts` | vitest |
| Full Tier 0 bootstrap-to-UI | E2E smoke | `tests/e2e/tier0-smoke.spec.ts` | Playwright |

### Critical contract tests (the regression net)

1. **dbClient tier parity** — for every method on `DbClient` interface, both `tier0.ts` and `tier1.ts` must return the same shape given the same logical inputs. The test parameterises over an expectation table:

```ts
// src/lib/dbClient/contract.test.ts
const cases = [
  { method: 'events.list', input: { userId: U }, mockTier0Response: [...], mockTier1Response: [...], expected: [...] },
  // ... ~40 cases covering every method
]
for (const tier of ['tier0', 'tier1']) {
  describe(`${tier} contract`, () => {
    for (const c of cases) {
      it(c.method, async () => { /* assert dbClient[c.method](c.input) === c.expected */ })
    }
  })
}
```

2. **Handler runtime parity** — `_shared/handlers/<name>.test.ts` runs each handler twice: once with a Node pg client, once with a Deno-compatible stub pg client. Asserts identical Response body + status. Regression net for the Deno-vs-Node refactor.

3. **Storage path traversal** — `backend/src/routes/storage/eventPhotos.test.ts` asserts that `..`, absolute paths, and symlinks outside the photos root all 400.

4. **GUC isolation** — `backend/src/db.test.ts` (mirror of `mcp/src/db.test.ts` from Phase 1) asserts no GUC leak between checkouts under concurrent load.

### Test fixtures

- Phase 2 reuses Phase 1's fixture: a vitest `setup.ts` spins up the embedded Postgres against a temp `pgdata` dir, applies migrations, inserts a test user, exports `TEST_DATABASE_URL` + `TEST_USER_ID`. Each test suite gets a fresh DB.
- For Tier 1 edge function tests, we mock the JWT verifier (no live GoTrue dependency in test runs).

### E2E smoke (`tests/e2e/tier0-smoke.spec.ts`)

Playwright script that:
1. Runs `bash scripts/bootstrap.sh --tier 0 --non-interactive --email smoke@plannen.local` against a temp `HOME`.
2. Starts `npm run dev` against the test env.
3. Loads `http://localhost:4321`, asserts no login page appears, asserts the user's name shows in the header.
4. Creates an event via the UI, uploads a photo, asserts the photo renders from `/storage/v1/object/...`.
5. Tears down.

Runs in CI as the Tier 0 bootstrap workflow (planned in Phase 1 Task 10) plus a `pnpm e2e` step.

### What we explicitly do NOT test in Phase 2

- Performance / load — single-user app.
- Concurrent writes — single-user app.
- Multi-tenant isolation — out of scope per spec.
- Real Google OAuth flow in CI — too brittle; rely on manual smoke + handler unit test with mocked Google responses.

## Risks

1. **Edge function refactor breaks Tier 1.** Pulling supabase-js out of every edge function and replacing with explicit JWT verify + pg client is a large, non-reversible change. Mitigation: pure handler tests run against both runtimes (contract parity); manual Tier 1 smoke before merge; we keep the spec's "Tier 1 must keep working unchanged for users" promise by changing only internal implementation, not the wire contract.

2. **JWT verification correctness.** Today the edge functions implicitly trust supabase-js's verification. The new code does explicit RS256 verification against Supabase's JWKS. Bugs here = either auth bypass (critical) or user lockout (annoying). Mitigation: use `jose`, test verification with valid + expired + wrong-issuer tokens, fail-closed by default.

3. **dbClient contract drift.** Two implementations of the same interface across 16 domains means ~40 methods that can diverge. Mitigation: the parameterised contract test in §Testing covers every method on both impls; CI fails if Tier 0 returns a shape Tier 1 doesn't.

4. **Storage URL compatibility.** If Supabase ever changes its storage URL format, our Tier 0 mirror diverges silently. Mitigation: the existing `media_url` column already stores Supabase's current shape; freezing on it is an explicit choice. Document in `docs/INTEGRATIONS.md` that Plannen pins this URL shape.

5. **Realtime parity gap.** Tier 0 polling means stories take up to 30s to appear in the UI after Claude writes one. For a single-user app this is acceptable; users running both Claude and the web app simultaneously will notice the lag. Mitigation: document the cadence; future work can replace polling with SSE if friction shows.

6. **Backend process drift from edge function entry.** Two entry points (`backend/src/routes/functions/*` and `supabase/functions/*/index.ts`) both wrap the same handler. Easy for the two to drift. Mitigation: a TS test asserts every handler under `_shared/handlers/` has both entries.

7. **Multipart file uploads on Node + Hono.** Hono's multipart helpers are less battle-tested than Express's. If we hit limits (large files, weird MIME), we'll need to swap in `@hono/node-server`'s body parser or fall back to raw streams. Mitigation: validate at smoke time with the actual photo sizes Plannen users upload (≤ 20MB typical).

## External dependencies added in Phase 2

| Package | Why | Risk |
|---|---|---|
| `hono` | HTTP framework | Healthy, growing community; low risk |
| `@hono/node-server` | Node adapter | Maintained by same team |
| `jose` | JWT verification (RS256 / JWKS) | Industry standard; low risk |
| `multer` or `@hono/node-multer` | Multipart parsing | TBD in plan; might use raw streams if simpler |

## Removed in Phase 2

- `@supabase/supabase-js` from `supabase/functions/_shared/ai.ts` and the 12 edge functions. Kept in `src/lib/supabase.ts` because the Tier 1 web app still uses it via `dbClient/tier1.ts`.

## Scope estimate

About 90 file touches total, mostly mechanical:

- ~12 new pure handler files in `supabase/functions/_shared/handlers/`
- ~14 new `backend/src/routes/api/*.ts` files (some service files share endpoints — e.g. `calendarExport` doesn't get its own route)
- ~12 new `backend/src/routes/functions/*.ts` wrappers
- 1 new storage route file
- 12 edge function entry points trimmed
- 16 service files trimmed to 1-liners
- 2 new `dbClient/tier{0,1}.ts` files + factory + types
- 1 `AuthContext.tsx` branch
- 1 `useStories.ts` branch
- 2 bash scripts
- 1 `vite.config.ts` proxy block
- 1 spec (this doc), 1 plan (next step)
- ~30 test files

## Cross-references

- [`2026-05-14-plannen-storage-tiers-design.md`](./2026-05-14-plannen-storage-tiers-design.md) — Tier 0/1/2/3+ model and audit; this spec implements the Phase 2 row of that design.
- [`2026-05-14-plannen-tier-0-phase-1.md`](../plans/2026-05-14-plannen-tier-0-phase-1.md) — Phase 1 plan; ships embedded Postgres + MCP refactor before this spec's plan executes.
- `docs/INTEGRATIONS.md` (created in Phase 1 Task 9) — list of integrations; this spec adds the storage URL pin as a documented integration assumption.

## Open questions

- **Multipart parser choice.** `multer` vs `@hono/node-multer` vs raw streams. Defer to plan: the plan should pick during the storage-route task and document the choice.
- **Backend port collision policy.** Default `54323`. If busy, error with a clear `PLANNEN_BACKEND_PORT=<other>` override hint (mirrors Phase 1's pg port handling).
- **Tier 2 path.** This spec's `dbClient/tier0.ts` works for Tier 2 (any Postgres URL behind the same backend). No additional code path needed; `VITE_PLANNEN_BACKEND_MODE=plannen-api` covers both. Documented here, not separately handled in the plan.

## Spec change log

- 2026-05-14: Initial draft.
