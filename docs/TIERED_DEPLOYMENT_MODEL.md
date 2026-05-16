# Tiered Deployment Model

Plannen runs in a small set of tiers. The ladder is shaped by four axes: **where the data lives**, **where compute lives**, **where the MCP server lives**, and **who operates the infrastructure**. Publishing / social-graph features are orthogonal — any tier can opt into them when they ship.

| Tier | Stack | Operator | Positioning |
|---|---|---|---|
| **Tier 0 — Bundled** *(default)* | Embedded pg + local Node/Hono backend on `54323` + local MCP (stdio) | User (just Node 20+) | Easy onboarding |
| **Tier 1 — Local Supabase** | Local Supabase Docker (full stack locally — pg + Auth + Storage + Edge Functions + local MCP stdio) | User (Docker + Supabase CLI) | Dev / contributor |
| **Tier 2 — Self-Hosted Cloud** *(this brainstorm)* | Supabase Cloud — DB + Auth + Storage + Edge Functions deployed + MCP deployed as Edge Function (HTTP transport). Plugin-only locally. | User (own Supabase Cloud project) | Serious cloud alternative |
| **Tier 3 — Plannen SaaS** *(out of scope here)* | Same shape as Tier 2, managed by Plannen | Plannen | Future SaaS |

**Cost ladder.** Tier 0 = free, no setup beyond Node. Tier 1 = free, requires Docker. Tier 2 = free on Supabase Cloud's free tier; pay if you exceed. Tier 3 = pay Plannen.

**The MCP differentiator.** Tiers 0–1 run the MCP server locally as a stdio subprocess of Claude Code / Desktop. Tier 2 (and Tier 3) host the MCP server in the cloud as a Supabase Edge Function and expose it over HTTP, so any MCP-aware agent — Claude Code, Claude Desktop, the user's own — can reach it. Remote MCP exposure is the defining feature of cloud-hosted Plannen, not a sub-mode.

**Default tier.** Tier 0 is the default for `bash scripts/bootstrap.sh` with no flag. Tier 1 stays available via `--tier 1`. The OSS-release framing is "runs with just Node" rather than "runs with Docker + Supabase."

## The abstraction boundary

Two abstractions, not one — because the web app cannot speak raw Postgres.

**Server-side: Postgres connection.** MCP server and the Node HTTP backend share a single `pg.Pool` driven by `DATABASE_URL`, with a `withUserContext(userId, fn)` helper that sets `app.current_user_id` (Tier 0 stub) and `request.jwt.claim.sub` (Tier 1 real) GUCs so `auth.uid()` resolves correctly across tiers.

**Client-side: HTTP API contract.** The web app's `src/services/*.ts` calls go through a `dbClient` factory at `src/lib/dbClient.ts`. Tier 1 wraps `@supabase/supabase-js`; Tier 0/2 use `fetch` against the local backend's REST surface (`/api`, `/storage/v1`, `/functions/v1`). Components are unchanged.

## What's in this repo

Tier 0 ships as the default in v0.2.0; Tier 1 stays fully supported. Tier 2 (Self-Hosted Cloud) is the next tier to ship — full Supabase Cloud install including the MCP server as a deployed Edge Function. Phase 1 of Tier 2 is Supabase-only; a future Phase 2 adds pluggable adapters so users can pick their DB (Supabase / Neon / any pg URL), Storage (Supabase Storage / S3-compatible / Google Drive), and Auth (Supabase / single-user stub) provider per axis. Tier 3 (Plannen SaaS) is not part of the OSS plan.

Storage tiers are orthogonal to publishing / social features. The earlier doc's "publish opt-in / social layer" idea folds in as a future feature flag rather than its own tier.
