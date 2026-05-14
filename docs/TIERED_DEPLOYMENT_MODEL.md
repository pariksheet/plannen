# Tiered Deployment Model

Plannen runs in a small set of tiers. The choice is one axis: **where Postgres lives and which services around it Plannen ships vs. assumes.** Publishing / social-graph features are orthogonal — any tier can opt into them when they ship.

| Tier | Postgres | Auth | Storage | HTTP API (today's edge functions) | Who installs |
|---|---|---|---|---|---|
| **Tier 0 — Bundled** *(new starter, default)* | `embedded-postgres` binary started by Node, listens on local port | `auth.uid()` stub from session GUC; no login UI | Local filesystem under `~/.plannen/photos/`, served by the Phase 2 backend stub | Node backend process (`backend/`) on a local port | New users — runs with just Node 20+ |
| **Tier 1 — Local Supabase** *(today)* | Postgres in the Supabase Docker stack | Supabase Auth (GoTrue) magic-link | Supabase Storage with xattrs | Supabase Edge Functions (Deno) | Existing users — Docker + Supabase CLI |
| **Tier 2 — External Postgres** *(future)* | Any Postgres URL (Neon, hosted Supabase Cloud, self-hosted) | Tier-dependent | Tier-dependent | Backend stub points at the remote DB | Users wanting cloud storage |
| **Tier 3+ — Hosted Plannen** *(out of scope here)* | Managed | Managed | Managed | Managed | Future commercial offering |

**Cost ladder.** Tier 0 = free, no setup beyond Node. Tier 1 = free, requires Docker. Tier 2 = pay your hosting provider. Tier 3+ = pay Plannen.

**Default tier.** Tier 0 is the default for `bash scripts/bootstrap.sh` with no flag. Tier 1 stays available via `--tier 1`. The OSS-release framing is "runs with just Node" rather than "runs with Docker + Supabase."

## The abstraction boundary

Two abstractions, not one — because the web app cannot speak raw Postgres.

**Server-side: Postgres connection.** MCP server and the (Phase 2) HTTP backend share a single `pg.Pool` driven by `DATABASE_URL`, with a `withUserContext(userId, fn)` helper that sets the `app.current_user_id` GUC so `auth.uid()` resolves correctly across tiers.

**Client-side: HTTP API contract.** The web app's `src/services/*.ts` calls go through a `dbClient` factory at `src/lib/dbClient.ts`. Tier 1 wraps `@supabase/supabase-js`; Tier 0/2 use `fetch` against the local backend's REST surface (`/api`, `/storage/v1`, `/functions/v1`). Components are unchanged.

## What's in this repo

Phase 1 (MCP path) and Phase 2 (backend + web app) ship Tier 0 by default while keeping Tier 1 fully working. Tier 2 is a future config change (point `DATABASE_URL` elsewhere); Tier 3+ is not part of the OSS plan.

Storage tiers are orthogonal to publishing / social features. The earlier doc's "publish opt-in / social layer" idea folds in as a future feature flag rather than its own tier.
