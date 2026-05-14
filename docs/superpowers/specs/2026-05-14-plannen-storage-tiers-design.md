# Plannen Storage Tiers — Design

**Date:** 2026-05-14
**Status:** Design approved; pending spec review and implementation plan
**Branch:** worktree-spec+storage_tiers (off `main`)

## Context

Plannen today ships a single deployment shape: a local Supabase Docker stack (Postgres + Auth + Storage + Edge Runtime + Studio + Kong) wrapped by `bash scripts/bootstrap.sh`. New users need Docker, the Supabase CLI, and patience for a multi-container start before they see anything work. The framing in `docs/TIERED_DEPLOYMENT_MODEL.md` already gestures at multiple tiers (local, cloud storage, publish, hosted) but every tier in that document assumes Supabase-the-vendor as the backend.

The reality the project is converging on is simpler: **Plannen runs on Postgres**. Everything Supabase wraps around Postgres — auth, storage, edge functions, the REST layer — is one possible *integration* set, not Plannen's identity. A user who wants to point Plannen at a Neon database, or at a single embedded Postgres binary, or at a future hosted Plannen service, should not have to pay the cost of running an entire Supabase stack.

This spec defines that shift: a **connection-string-centric data layer** with **tier-specific service layers** above it, and a new **Tier 0 starter** that bundles Postgres in-process so a new user runs Plannen with just Node 20+.

The spec is companion to the plugin architecture design (`2026-05-09-plannen-plugin-architecture-design.md`) and supersedes the existing `docs/TIERED_DEPLOYMENT_MODEL.md`.

## Goals & non-goals

### Goals

- A new user can clone Plannen and run it with **one prerequisite (Node 20+)** — no Docker, no Supabase CLI.
- The abstraction boundary is the **Postgres connection string**. Every code path that reads or writes data resolves to a `pg`-compatible connection, regardless of tier.
- The MCP server, the new HTTP backend, and the web app are **portable across tiers** with one env-var switch — not a code branch.
- Existing Tier 1 users (today's local Supabase setup) keep working unchanged after this lands.
- Future hosted Plannen and "bring your own Postgres" deployments are supported by the same abstraction — no rewrite needed.
- Documentation reframes Postgres as the system of record and clearly names other tools (Google Calendar, Google Photos, etc.) as **integrations**, never alternative storage.

### Non-goals

- **Hosted Plannen (Tier 3+)** itself. The abstraction must not preclude it, but building it is out of scope.
- **A full multi-user system.** Plannen stays single-user-per-instance at every tier covered here. Multi-user is a Tier 3+ concern.
- **Replacing Supabase JS in the web app in one pass.** The implementation plan stages this — Phase 1 ships Tier 0 for the MCP / Claude path; Phase 2 refactors the web app's data access. Both phases ship under this spec's architecture.
- **A Tier-0 magic-link auth UI.** Tier 0 trusts the local connection and the `.env`-configured user. Magic-link login stays a Tier 1+ feature.
- **A generic plugin framework.** Kitchen and any future plugins inherit this storage abstraction by convention, not by a new framework layer.

## Tier model (replaces `docs/TIERED_DEPLOYMENT_MODEL.md`)

One axis: where Postgres lives and which services around it Plannen ships vs. assumes. The earlier doc's "publish opt-in / social layer" idea folds in as a future feature flag rather than its own tier — any tier can opt into publishing once we ship that feature.

| Tier | Postgres | Auth | Storage | HTTP API (today's edge functions) | Who installs |
|---|---|---|---|---|---|
| **Tier 0 — Bundled** *(new starter)* | `embedded-postgres` binary started by Node, listens on local port | `auth.uid()` stub from session GUC; no login UI | Local filesystem under `~/.plannen/photos/`, served by backend stub | Node backend process (`backend/`) on a local port | New users — runs with just Node 20+ |
| **Tier 1 — Local Supabase** *(today)* | Postgres in the Supabase Docker stack | Supabase Auth (GoTrue) magic-link | Supabase Storage with xattrs | Supabase Edge Functions (Deno) | Existing users — Docker + Supabase CLI |
| **Tier 2 — External Postgres** | Any Postgres URL (Neon, ghost.build, hosted Supabase Cloud, self-hosted) | Tier-dependent: if the URL has Supabase services, use them; otherwise GUC stub | Tier-dependent | Backend stub points at the remote DB | Users wanting cloud storage |
| **Tier 3+ — Hosted Plannen** *(out of scope)* | Managed | Managed | Managed | Managed | Future |

**Cost ladder.** Tier 0 = free, no setup beyond Node. Tier 1 = free, requires Docker. Tier 2 = pay-as-you-go to hosting provider. Tier 3+ = pay Plannen.

**Default tier.** Tier 0 becomes the default for `bash scripts/bootstrap.sh` with no flag. Tier 1 stays available via `--tier 1`. The OSS-release messaging frames Plannen as "runs with just Node" rather than "runs with Docker + Supabase."

## The abstraction boundary

Two abstractions, not one — because the web app cannot speak raw Postgres.

### Server-side: Postgres connection (used by MCP server + new backend)

The MCP server and the new HTTP backend drop `@supabase/supabase-js` for DB access and use plain `pg` (node-postgres) via a shared connection-pool helper:

```
backend/ ─┐
mcp/      ├──→ db.ts (pg.Pool, single DATABASE_URL env var) ──→ Postgres
          │                                                     (Tier 0: embedded
          │                                                      Tier 1: local Supabase
          │                                                      Tier 2: external URL)
```

Contract:

- One env var: `DATABASE_URL`. Bootstrap writes the right one per tier.
- Per-connection identity setup: `SELECT set_config('app.current_user_id', $1, true)` so `auth.uid()` resolves to the right UUID via the GUC stub (see § Tier 0 mechanics).
- "Service-role" — any connection that skips the GUC setup. Used by MCP admin operations and migration runs.

Today's `supabase.from('events').select(...)` calls in `mcp/src/index.ts` and the helper modules (`profileFacts.ts`, `sources.ts`, etc.) become `pool.query(...)` or thin query-builder calls. The existing module boundaries in `mcp/src/` survive — only the inside of each helper changes.

### Client-side: HTTP API contract (used by the web app)

The web app keeps speaking HTTP — to **either** Supabase's PostgREST + GoTrue + Storage REST API (Tier 1) **or** the new Plannen backend (Tier 0, and Tier 2 when no Supabase services are present):

```
src/services/*.ts ──→ dbClient ──┬──→ Tier 1: @supabase/supabase-js → PostgREST → Postgres
                                 │
                                 └──→ Tier 0/2: fetch → backend/ → pg → Postgres
```

`dbClient` is a factory at `src/lib/dbClient.ts`. It exposes a stable interface (`events.list()`, `events.create()`, `memories.upload()`, etc.) and picks an implementation from `import.meta.env.VITE_PLANNEN_BACKEND_MODE` = `supabase` or `plannen-api`.

- **Tier 1** implementation wraps `@supabase/supabase-js` — minimal divergence from today, since `src/services/*.ts` maps cleanly.
- **Tier 0/2** implementation is fetch-based, hitting the backend's REST surface (`GET /api/events?...`, `POST /api/events`, etc.). Backend handlers reuse the same SQL the MCP server uses.

Implication: the web app refactor is **scoped to the service layer**. Components keep calling `eventService.list()`; the service layer routes through `dbClient` instead of importing `supabase` directly.

### What this buys us

- The **MCP server is portable across all tiers immediately** — same `pg.Pool` code, different `DATABASE_URL`. No tier-specific branches in MCP. This is what makes staged delivery possible (Phase 1 = MCP + Claude path on Tier 0 with no web app changes).
- The **web app gets one tier-switch knob** instead of 24 files importing the Supabase client directly.
- **Tier 2 ("any Postgres URL")** works trivially for the MCP / Claude path the day Phase 1 lands — even before the web-app refactor.

## Tier 0 starter mechanics

### Repository additions

```
plannen/
├── backend/                          ← NEW (Tier 0 HTTP API + photo serving)
│   ├── src/
│   │   ├── index.ts                  Hono/Express server bootstrap
│   │   ├── routes/
│   │   │   ├── functions/            mirrors supabase/functions/* routes
│   │   │   ├── api/                  Plannen REST surface (events, memories, …)
│   │   │   └── storage/              GET/PUT /storage/v1/object/event-photos/*
│   │   ├── db.ts                     pg.Pool + withUserContext helper
│   │   └── deno-shim.ts              Deno.env / npm:/jsr: portability layer
│   ├── package.json
│   └── tsconfig.json
│
├── supabase/migrations/              ← unchanged (initial_schema.sql etc.)
├── supabase/migrations-tier0/        ← NEW (auth/storage stubs applied only in Tier 0)
├── supabase/functions/_shared/       ← unchanged; backend/ imports from here via shim
│
├── scripts/
│   ├── bootstrap.sh                  ← gains --tier flag (default: 0)
│   ├── pg-start.sh                   ← NEW: start embedded postgres (Tier 0)
│   ├── pg-stop.sh                    ← NEW
│   └── backend-start.sh              ← NEW: start the backend process
│
└── .env                              ← gains DATABASE_URL, PLANNEN_TIER, BACKEND_URL,
                                       VITE_PLANNEN_BACKEND_MODE
```

`mcp/` and `supabase/functions/_shared/` keep their locations. The new `backend/` is a thin process whose handlers mostly import existing logic via the Deno shim.

### `bootstrap.sh --tier 0` flow

1. Pre-flight: Node ≥ 20, pnpm. **No** Docker check, **no** Supabase CLI check.
2. `pnpm install` — pulls `embedded-postgres` (downloads platform binary on first install).
3. Email cascade: Claude email → git email → prompt. Same as today.
4. `pnpm exec plannen-pg init` — creates `~/.plannen/pgdata/`, runs `initdb`, starts the binary on `127.0.0.1:54322`, writes pidfile to `~/.plannen/pg.pid`.
5. Run migrations: `pnpm exec plannen-pg migrate` applies `supabase/migrations/*.sql` then `supabase/migrations-tier0/*.sql` against the embedded DB.
6. Create the single user row: `INSERT INTO plannen.users (id, email) VALUES (gen_random_uuid(), $1)`.
7. Build MCP + backend: `pnpm --filter mcp build && pnpm --filter backend build`.
8. Write `.env`:
    ```
    PLANNEN_TIER=0
    DATABASE_URL=postgres://plannen@127.0.0.1:54322/plannen
    PLANNEN_USER_EMAIL=<resolved>
    BACKEND_URL=http://127.0.0.1:54323
    VITE_PLANNEN_BACKEND_MODE=plannen-api
    ```
9. Start backend: `bash scripts/backend-start.sh` (idempotent, manages pidfile).
10. Offer Claude plugin install (existing flow).
11. Print: "Open `npm run dev` for the web app at http://localhost:4321."

After reboot: `bash scripts/pg-start.sh && bash scripts/backend-start.sh`. No Docker daemon required.

### Tier-0-only migration overlay

`supabase/migrations-tier0/00000000000000_tier0_compat.sql` applies **after** the main migrations in Tier 0:

```sql
-- auth schema stub (Supabase normally provides this).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.current_user_id', true)::uuid $$;

-- storage schema stub so the bucket-policy DDL in initial_schema.sql doesn't fail.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE IF NOT EXISTS storage.objects (
  bucket_id text, name text, owner uuid, created_at timestamptz DEFAULT now(),
  metadata jsonb, PRIMARY KEY (bucket_id, name)
);

-- stub auth.users so the handle_new_user trigger has something to fire on
-- (bootstrap inserts into plannen.users directly; this is just to satisfy FK / trigger DDL).
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
```

The existing `00000000000000_initial_schema.sql` applies cleanly because the storage-policy DDL is already wrapped in `DO $$ ... pg_policies ... $$` guards (added to be idempotent for Tier 1 re-runs). Those guards no-op in Tier 0 since the policies reference Supabase-internal roles that don't exist.

### Per-connection identity (the GUC)

`backend/src/db.ts` and `mcp/src/db.ts` share this pattern:

```ts
async function withUserContext<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    return await fn(client);
  } finally {
    client.release();
  }
}
```

`set_config(..., true)` is transaction-scoped, so the GUC dies when the client is released — no leak between pool checkouts. Service-role-style calls just skip `withUserContext` and the GUC is unset, which means `auth.uid()` returns NULL — RLS policies then fall back to whichever path treats anonymous as a service-role caller (today's policies have explicit service-role clauses for the admin paths).

### Migration runner

Tier 0 cannot rely on `supabase migration up` (Supabase CLI not installed). New runner: `pnpm exec plannen-pg migrate`. Implementation: a 50-line script that walks `supabase/migrations/*.sql` in order, applies each in a transaction, records applied versions in a `plannen.schema_migrations` table. Tier 1+ continues using `supabase migration up`; the CLI's migration table and the new one stay in sync because both apply the same SQL files.

### Failure modes

| Condition | Behaviour | User remediation |
|---|---|---|
| Embedded Postgres binary download blocked (corporate network) | `pnpm install` fails with a clear error | Document fallback to Tier 1 in the troubleshooting section |
| Port 54322 in use | `pg-start.sh` errors with the conflict | `PLANNEN_PG_PORT=<other>` override |
| Migration overlay drifts from new Supabase-internal-schema references in `initial_schema.sql` | Migration applies but later queries fail | CI job: `bootstrap.sh --tier 0` from scratch on every PR that touches `supabase/migrations/` |
| Web app started in Tier 0 with `VITE_PLANNEN_BACKEND_MODE=supabase` | Web app fails to authenticate (Phase 1 only) | Tier 0 bootstrap writes `plannen-api`; users who set this manually get a clear error |

## Audit of Supabase-specific dependencies

Each row marked **(T0)** is a Tier 0 / Phase 1 blocker, **(T0-web)** is a Phase 2 (web-app refactor) blocker, **(T1)** is Tier-1-only with no Tier 0 action needed.

| # | Surface | Today's dependency | Tier 0 status | Plan |
|---|---|---|---|---|
| 1 | `auth.uid()` in RLS policies (40+ sites) | Supabase Auth schema | Broken without stub | **(T0)** Tier-0 migration overlay creates `auth.uid()` from session GUC. No policy rewrites. |
| 2 | `auth.uid()` in SECURITY DEFINER functions in the schema | Same | Broken without stub | **(T0)** Same overlay |
| 3 | `auth.users` table referenced by `handle_new_user` trigger | Supabase Auth | Trigger fires on rows that don't exist | **(T0)** Overlay creates stub `auth.users`; bootstrap inserts directly into `plannen.users` |
| 4 | RLS enabled on every plannen.* table | RLS as security boundary | Single-user trust makes it redundant but not harmful | **(T0)** Keep enabled; GUC-fed `auth.uid()` makes policies evaluate correctly. Document as defence-in-depth, not security boundary |
| 5 | Supabase Storage `event-photos` bucket | Supabase Storage service | No service in Tier 0 | **(T0)** Backend `storage/` routes read/write `~/.plannen/photos/`; `media_url` keeps Supabase-compatible URL shape |
| 6 | `restore-photos.sh` xattr handling | Storage's xattr-driven serving | N/A | **(T1)** Tier-1-only; Tier 0 backup is `tar` of the photos dir |
| 7 | 13 edge functions in `supabase/functions/` | Supabase Edge Runtime (Deno) | No runtime in Tier 0 | **(T0)** Backend imports same handlers via `deno-shim.ts` (Deno.env → process.env, strip `npm:`/`jsr:` prefixes at build time) |
| 8 | `_shared/ai.ts` reads `user_settings` via JWT-scoped Supabase JS | Supabase JWT verification | No JWT in Tier 0 | **(T0)** Backend passes a synthetic session with configured user_id; `getUserAI` reads via `pg` + GUC |
| 9 | `@supabase/supabase-js` in 24 web-app files | PostgREST + GoTrue + Storage REST | Web app fails to start in Tier 0 (Phase 1) | **(T0-web)** `src/lib/dbClient.ts` factory; `src/services/*.ts` route through it |
| 10 | Magic-link auth via Mailpit + `auth.getUser()` | Supabase Auth + Inbucket | No auth flow in Tier 0 | **(T0-web)** `AuthContext` checks `PLANNEN_TIER`; Tier 0 short-circuits to the configured user, no login page |
| 11 | Supabase Realtime subscriptions in web app (extent TBD — needs grep audit during implementation) | Postgres logical replication + WS server | No Realtime in Tier 0 | **(T0-web)** Implementation-plan item: audit `src/` for `.subscribe()` calls, decide polling or SSE fallback |
| 12 | `supabase migration up` CLI | Supabase CLI's migration runner | Not available | **(T0)** New `pnpm exec plannen-pg migrate`. Tier 1+ keeps `supabase migration up` |
| 13 | `supabase/functions/.env` for secrets | Edge-function env split | Not used | **(T0)** Single `.env` at repo root; backend reads from there |
| 14 | Mailpit on port 54324 | Supabase local stack | No mail flow in Tier 0 (no login) | **(T1)** Tier-1-only. Tier 2 users wanting magic-link auth bring a real SMTP sender |
| 15 | `auth.users` signup trigger creates `plannen.users` row | Supabase Auth signup hook | No signup in Tier 0 | **(T0)** Bootstrap inserts the row directly |

## Integrations vs. storage framing

### The rule

> **Postgres is Plannen's system of record. Every other place your data shows up is an integration: a read-only view, a write-mirror, or an export.**

This rule applies regardless of tier choice — Tier 0, 1, 2, or 3+, Postgres is always the system of record.

### Current integrations

| Surface | Role | Direction |
|---|---|---|
| Google Calendar | write-mirror | Plannen → GCal (`get_gcal_sync_candidates` / `set_gcal_event_id` MCP tools) |
| Google Photos | read-source | GPhotos → Plannen (picker session attaches existing photos to events) |
| Google Drive | storage-mirror for memory uploads | Plannen ↔ Drive (proxied via owner token) |
| WhatsApp / email | notification sink | Plannen → user's inbox |

**New integrations** (Notion, Ghost, anything else) ship as separate design specs when proposed, not as predetermined slots.

### Documentation changes

1. **Rewrite `docs/TIERED_DEPLOYMENT_MODEL.md`** around the Tier 0–3+ model in this spec. Note that integrations are orthogonal to tier choice.
2. **README.md § "Why it works"** — add one paragraph after the MCP-server description:
   > Plannen's data lives in Postgres on your machine (or wherever you pointed your `DATABASE_URL`). Tools you connect — like Google Calendar or Google Photos — are integrations on top of that store, not alternatives to it. You can mirror an event to your calendar; you can't replace Plannen's database with your calendar.
3. **New `docs/INTEGRATIONS.md`** — one-pager listing each current integration, direction, trigger, config location.
4. **`/plannen-setup` onboarding** — never offers "choose your storage" between Postgres and any integration. Storage choice is tier choice; integrations are separate add-ons configured per-feature.

## Kitchen plugin spec updates

The kitchen plugin spec (`2026-05-14-plannen-kitchen-plugin-design.md`, currently untracked on `feat/postgres_decoupled`) is mostly backend-neutral. Targeted edits:

1. **Architecture decisions table** — update the "Schema isolation" row from "shared local Supabase" to "same Plannen Postgres (whichever tier — bundled, local Supabase, external)."
2. **Data model section** — add a one-line note: "The schema avoids `auth.uid()` directly; RLS stays off in v1 (single-user-local). If kitchen ever needs user-scoping, it follows Plannen's `app.current_user_id` GUC pattern."
3. **MCP isolation** — kitchen MCP imports the shared `db.ts` helper (`pg.Pool` + `withUserContext`) from a new `@plannen/db` internal package extracted during Phase 1.
4. **UI surface / Web access** — replace "uses the existing Plannen Supabase JS client (anon key + user JWT)" with "goes through Plannen's `dbClient` factory at `src/lib/dbClient.ts`, which picks the right backend per tier."
5. **`install.sh` flow** — `Apply migrations: pnpm exec plannen-pg migrate` in Tier 0; `supabase migration up` in Tier 1+. `install.sh` dispatches based on `PLANNEN_TIER`.
6. **New "Tier compatibility" subsection** — kitchen works at every tier because it inherits Plannen's storage abstraction.

What stays unchanged: the 3-table schema + view, the ~10 CRUD MCP tools, the v1 in-store UI, install/uninstall symmetry, the cross-plugin "call Plannen MCP, never join across schemas" rule. Those decisions are tier-neutral.

The kitchen spec lives on a different branch right now (untracked on `feat/postgres_decoupled`). The edits above apply once that spec lands on `main` — either by merging the kitchen-spec branch first, or by re-creating the spec from this branch with the updates baked in. See Open Questions.

## Risks

- **Embedded-postgres binaries are a third-party dependency.** Plannen's bootstrap experience now depends on `embedded-postgres` (or equivalent) shipping working binaries for macOS-arm64, macOS-x64, linux-arm64, linux-x64, and Windows-x64. If the package goes unmaintained, fallback is "install Postgres yourself + set `DATABASE_URL`," which is essentially Tier 2.
- **Migration overlay drift.** `supabase/migrations-tier0/` must keep up with any new Supabase-internal schema reference added to `00000000000000_initial_schema.sql`. CI mitigates but doesn't eliminate.
- **Web-app refactor scope.** 24 service files plus auth context plus any Realtime subscriptions. The staged approach (Phase 2 follow-up) means Tier 0 ships with a known gap — Claude path works, web app doesn't — until Phase 2 lands. Worth being explicit in OSS-release messaging.
- **Deno→Node shim brittleness.** Edge function handlers in `supabase/functions/` use `Deno.env`, `npm:` import prefixes, and `jsr:` import prefixes. The shim has to translate all three. New edge functions written Deno-first risk new shim work; the shim should error loudly on unhandled imports rather than silently miscompile.
- **GUC-based identity is a single-user model.** A multi-tenant Tier 3+ would need a different approach (real JWTs, real RLS-as-security-boundary). The spec doesn't preclude this but doesn't design for it either.

## Open questions

1. **Kitchen spec branching.** The kitchen plugin spec is currently untracked on `feat/postgres_decoupled`. Do we (a) merge that branch to `main` first and then PR the storage-tiers spec with kitchen edits applied, (b) cherry-pick the kitchen spec into this branch and apply edits in one PR, or (c) ship storage-tiers first and re-PR kitchen spec with edits later? Recommend (b).
2. **Default tier for new users.** Should `bash scripts/bootstrap.sh` (no flag) default to Tier 0 once Phase 1 ships, or stay defaulting to Tier 1 until Phase 2 closes the web-app gap? Recommend defaulting to Tier 1 until Phase 2 lands, then switching the default — but the README starts mentioning `--tier 0` as a one-liner option immediately.
3. **Backend HTTP framework.** Hono vs Express vs Fastify for `backend/`. No strong reason to pick yet; Hono is appealing because handlers can run in both Node and Deno (potentially future-unifying with Tier 1's edge-function path). Implementation plan decides.
4. **Schema-migrations table location.** `plannen.schema_migrations` (Plannen-owned) vs reusing Supabase CLI's `supabase_migrations.schema_migrations`. Picking the former keeps Tier 0 free of Supabase-named artifacts; picking the latter keeps Tier 1 and Tier 0 in lock-step. Implementation plan decides.
5. **Realtime subscriptions audit.** Need an actual grep of `src/` during implementation to know how much of the web app's UX depends on Supabase Realtime. If significant, Phase 2 grows; if minimal, polling is fine.

## Cross-references

- `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` — plugin design this spec extends.
- `docs/superpowers/specs/2026-05-14-plannen-kitchen-plugin-design.md` — kitchen plugin design that needs the edits listed above.
- `docs/TIERED_DEPLOYMENT_MODEL.md` — to be rewritten under this spec's tier model.
- Memory: `project_deployment_model.md`, `project_pending_features.md`.

## Spec change log

- 2026-05-14: Initial draft.
