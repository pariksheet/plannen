# Changelog

All notable changes to Plannen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-14

Tier 0 storage model. Plannen now runs on a fresh machine with **just Node 20+** — no Docker, no Supabase CLI. The existing local-Supabase path (now called Tier 1) stays fully supported via `bash scripts/bootstrap.sh --tier 1`.

### Added

- **Tier 0 — embedded Postgres** (`embedded-postgres` started by Node on port 54322). New user runs one command (`bash scripts/bootstrap.sh`) and gets the full app, MCP, and web UI without any container runtime.
- **Tier-aware bootstrap** — `scripts/bootstrap.sh --tier 0|1` (default 0). Tier 0 path skips Docker/Supabase prereqs, inits embedded pg, applies migrations (Tier-0 compat overlay + main schema), inserts the user row, builds + starts the new Node backend, optionally starts the web dev server. Auto-restores `supabase/seed.sql` and `supabase/seed-photos.tar.gz` if present on a fresh DB.
- **Plannen backend** (`backend/`) — Hono + `@hono/node-server` mirror of Supabase's surface: `/api/{events,memories,stories,profile,relationships,locations,sources,watch,rsvp,groups,wishlist,settings,agent-tasks,me}`, `/storage/v1/object/event-photos/*`, `/functions/v1/{12 handlers}`, `/health`. Talks to Postgres via `pg.Pool` + `withUserContext(userId)` GUC helper.
- **Pure handler architecture** — all 12 Supabase edge functions extracted to `supabase/functions/_shared/handlers/<name>.ts` with shape `(req, {db, userId}) => Response`. Same handler code runs under Deno (Tier 1) and Node (Tier 0); each runtime entry verifies its own auth and opens its own pg client. Deno entries verify Supabase JWTs via `jose`; the `_shared/ai.ts` BYOK wrapper takes a handler ctx instead of a Request.
- **Web `dbClient` factory** (`src/lib/dbClient.ts`) — domain-keyed (`dbClient.events.list()`, `dbClient.memories.uploadFile(...)`, etc.) with two implementations: `tier1.ts` wraps `@supabase/supabase-js`, `tier0.ts` uses `fetch` against the local backend. 16 services in `src/services/*` now route through it. Contract test asserts both tiers expose the same surface.
- **Tier-0 AuthContext** — no login UI, no Supabase Auth round-trip; the backend resolves the user at boot from `PLANNEN_USER_EMAIL` and exposes them via `GET /api/me`.
- **Realtime polling fallback** — `useStories` switches from Postgres Realtime to a 30s `setInterval` in Tier 0.
- **Lifecycle umbrellas** — `scripts/start.sh` (`--no-dev` for headless / MCP-only) and `scripts/stop.sh` read `PLANNEN_TIER` and bring up / shut down the right stack. README documents a copy-paste macOS LaunchAgent for autostart on login.
- **Cross-tier backup/restore** — `scripts/export-seed.sh` is tier-aware: Tier 0 uses a pure-Node table dumper (`scripts/lib/dump-tables.mjs`) so a Homebrew pg_dump@16 doesn't choke on embedded pg 18+. `scripts/restore-photos.sh` likewise branches to a Node extractor (`scripts/lib/restore-photos.mjs`) that flattens Supabase Storage's `<file>/<version-uuid>` layout into the flat layout Tier 0 serves.
- **CI** — `.github/workflows/tier-0-bootstrap.yml` runs `bootstrap.sh --tier 0` from scratch on every PR that touches migrations, scripts, backend, or web data-layer files, then runs mcp + backend + handler + dbClient-contract tests and a Playwright smoke.

### Changed

- **`mcp/src/index.ts`** drops `@supabase/supabase-js`; uses `pg.Pool` + `withUserContext` against `DATABASE_URL`. All 38 tool handlers wrap their bodies in `withUserContext(userId, ...)` so `auth.uid()` resolves correctly under either tier.
- **`withUserContext`** sets both `app.current_user_id` (Tier 0 stub) and `request.jwt.claim.sub` (Tier 1 real) GUCs so the same client code works across tiers without runtime branching.
- **`scripts/bootstrap.sh`** prerequisite checks now skip Docker + Supabase CLI when Tier 0 (default).
- **`docs/TIERED_DEPLOYMENT_MODEL.md`** rewritten around the storage-tier axis (Tier 0/1/2/3+). The previous "publish/social-layer" tier idea folds into a future feature flag, orthogonal to storage.
- **`docs/INTEGRATIONS.md`** (new) — explicit separation of *integrations* (Google Calendar, Photos, Drive) from *tiers* (where Postgres + photos live).

### Fixed

- Tier 0 SQL overlay (`supabase/migrations-tier0/`) creates the `postgres`/`anon`/`authenticated`/`service_role` roles + `auth`/`storage`/`extensions` schemas + `auth.uid()` stub *before* the main migrations apply, so the squashed initial schema compiles cleanly against embedded pg.
- `pg`-driver type parser for `DATE` (OID 1082) now returns `YYYY-MM-DD` strings so `<input type=date>` accepts them without a re-format step.
- MCP env loading was racing the ESM import hoist (db.ts read `DATABASE_URL` before `loadDotenv()` ran). Moved the dotenv call into a side-effect module imported first; MCP now works with any `claude mcp add` env block as long as the repo `.env` exists.

### Notes

- Tier 0 is single-user by design. Cross-user/family/friends event feeds, group sharing, and friend-of-friend invites are still Tier-1 only — Tier 0 services degrade gracefully (empty lists, no-op writes) and the spec acknowledges this as a deliberate v0 scope.
- Existing Tier 1 users: nothing breaks. `bash scripts/bootstrap.sh --tier 1` keeps the Docker + Supabase path. Your `.env` and Docker volumes are untouched on upgrade.

## [0.1.0] - 2026-MM-DD

Initial public release. Plannen ships as a local-first AI planner that learns your preferences and turns events into memories, licensed under [AGPL-3.0](LICENSE).

### Added

- **Web app** — React + Vite calendar UI for events, family members, locations, RSVPs, memories, and stories.
- **MCP server** — single-file TypeScript wrapper that lets Claude Code and Claude Desktop read and write a local Plannen instance via Supabase.
- **Claude Code plugin** — installable via `/plugin install ./plugin`, bundling MCP registration, workflow skills (event-creation intent gate, profile extraction, source analysis, watch monitoring, story composition, photo organisation, discovery), and slash commands.
- **Slash commands** — `/plannen-doctor`, `/plannen-setup`, `/plannen-write-story`, `/plannen-organise-photos`, `/plannen-discover`, `/plannen-check-watches`, `/plannen-backup`.
- **BYOK AI keys** — per-user Anthropic API key stored in the local Supabase `user_settings` table, used server-side by edge functions; never sent on requests.
- **Bootstrap script** — `scripts/bootstrap.sh` performs a one-command first-run install: prereq checks, npm install, supabase start, migrations, auth-user creation, env-file generation, and optional plugin install.
- **Backup tooling** — `scripts/export-seed.sh` writes `supabase/seed.sql` and `supabase/seed-photos.tar.gz`; `scripts/restore-photos.sh` rebuilds storage objects with the xattrs the Supabase storage worker expects.
- **Google Photos integration** — picker-based attachment of photos to events via the Photos Library API.
- **Google Calendar sync** — outbound sync candidates surfaced via `get_gcal_sync_candidates`.
- **Stories** — AI-generated narratives for past events, multi-language (English, Marathi, Dutch by default).
- **Watch monitoring** — periodic re-check of saved event sources for date/registration changes.
- **CI** — GitHub Actions workflow runs web and MCP tests + builds on every PR (Linux + Node 20).
- **Contributor docs** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue and PR templates.

[Unreleased]: https://github.com/pariksheet/plannen/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pariksheet/plannen/releases/tag/v0.2.0
[0.1.0]: https://github.com/pariksheet/plannen/releases/tag/v0.1.0
