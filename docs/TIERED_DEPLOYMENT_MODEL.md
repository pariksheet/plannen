# Tiered Deployment Model

Plannen runs in a small set of tiers. The ladder is shaped by four axes: **where the data lives**, **where compute lives**, **where the MCP server lives**, and **who operates the infrastructure**. Publishing / social-graph features are orthogonal — any tier can opt into them when they ship.

| Tier | Postgres | Auth | Storage | Edge functions | MCP server | Operator |
|---|---|---|---|---|---|---|
| **Tier 0 — Bundled** *(default)* | `embedded-postgres` binary started by Node, listens on local port | `auth.uid()` stub from session GUC; no login UI | Local filesystem under `~/.plannen/photos/`, served by the Node backend | Local Node/Hono backend on `54323` | Local Node process, stdio transport | User (just Node 20+) |
| **Tier 1 — Local Supabase** | Postgres in the Supabase Docker stack | Supabase Auth (GoTrue) magic-link | Supabase Storage with xattrs | Supabase Edge Functions (local Deno) | Local Node process, stdio transport | User (Docker + Supabase CLI) |
| **Tier 2 — External Postgres** *(next — this brainstorm)* | Any Postgres URL (Neon, Supabase Cloud, self-hosted) | GUC stub, single user | Local filesystem (same as Tier 0) | Local Node/Hono backend (same as Tier 0) | Local Node process, stdio transport | User (DB hosting only) |
| **Tier 3 — Self-Hosted Cloud** *(future)* | Supabase Cloud Postgres | Supabase Auth | Supabase Storage | Supabase Edge Functions (deployed via `supabase functions deploy`) | Deployed as Supabase Edge Function, HTTP transport; plugin connects over the network | User (own Supabase Cloud project) |
| **Tier 4 — Plannen SaaS** *(out of scope here)* | Managed | Managed | Managed | Managed | Managed, exposed remote MCP | Plannen (commercial offering) |

**Cost ladder.** Tier 0 = free, no setup beyond Node. Tier 1 = free, requires Docker. Tier 2 = free on most providers' free tiers (Neon, Supabase Cloud); pay if you exceed. Tier 3 = pay Supabase (free tier available). Tier 4 = pay Plannen.

**The MCP differentiator.** Tiers 0–2 run the MCP server locally as a stdio subprocess of Claude Code / Desktop. Tier 3 (and Tier 4) host the MCP server on the cloud and expose it over HTTP so any MCP-aware agent — Claude Code, Claude Desktop, the user's own — can reach it. Remote MCP exposure is the defining feature of cloud-hosted Plannen, not a sub-mode.

**Default tier.** Tier 0 is the default for `bash scripts/bootstrap.sh` with no flag. Tier 1 stays available via `--tier 1`. The OSS-release framing is "runs with just Node" rather than "runs with Docker + Supabase."

## The abstraction boundary

Two abstractions, not one — because the web app cannot speak raw Postgres.

**Server-side: Postgres connection.** MCP server and the Node HTTP backend share a single `pg.Pool` driven by `DATABASE_URL`, with a `withUserContext(userId, fn)` helper that sets `app.current_user_id` (Tier 0 stub) and `request.jwt.claim.sub` (Tier 1 real) GUCs so `auth.uid()` resolves correctly across tiers.

**Client-side: HTTP API contract.** The web app's `src/services/*.ts` calls go through a `dbClient` factory at `src/lib/dbClient.ts`. Tier 1 wraps `@supabase/supabase-js`; Tier 0/2 use `fetch` against the local backend's REST surface (`/api`, `/storage/v1`, `/functions/v1`). Components are unchanged.

## What's in this repo

Tier 0 ships as the default in v0.2.0; Tier 1 stays fully supported. Tier 2 is the next tier to ship (point `DATABASE_URL` at a hosted Postgres; everything else stays exactly as Tier 0). Tier 3 (Self-Hosted Cloud) is a follow-up spec building on top of Tier 2. Tier 4 (Plannen SaaS) is not part of the OSS plan.

Storage tiers are orthogonal to publishing / social features. The earlier doc's "publish opt-in / social layer" idea folds in as a future feature flag rather than its own tier.
