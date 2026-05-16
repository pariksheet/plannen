# Tier 3 — Self-Hosted Cloud · Design Notes (deferred)

**Status:** Decisions captured during the 2026-05-16 brainstorm; full spec deferred until Tier 2 ships.

**Why deferred:** Tier 3 builds on Tier 2's tooling (connection-string-centric DB swap, lifecycle scripts, `plannen-doctor` updates). Ship Tier 2 first as the smaller, lower-risk rung; come back to Tier 3 with Tier 2 as ground truth.

## What "Tier 3" means

Fully cloud-hosted Plannen, operated by the user on their own Supabase Cloud project:

- **Postgres**, **Storage**, **Auth** → Supabase Cloud.
- **Edge functions** → deployed to the user's Supabase project via `supabase functions deploy`.
- **MCP server** → ported to a Supabase Edge Function with HTTP transport; the Claude Code plugin connects over the network with a bearer token.
- **Local install** → only the Claude Code plugin. No local Node backend, no local Postgres, no local MCP subprocess, no local web app in phase 1.

Tier 3 and Tier 4 (Plannen SaaS) have the same shape; only the operator differs. The remote MCP is exposed in both so any MCP-aware agent (Claude Code, Claude Desktop, user's own) can reach Plannen.

## Decisions locked in this session

- **Scope.** First-class install (`bash scripts/bootstrap.sh --tier 3`) + migration path (`scripts/migrate-to-tier3.sh`) from Tier 0 / Tier 2.
- **Provider.** Phase 1 supports Supabase Cloud only (DB + Storage + Auth + Edge Functions). Future phases may add other providers (Neon for DB, R2 / Google Drive for storage).
- **Architecture.** Fully cloud-hosted; no local services beyond the Claude Code plugin.
- **MCP host.** MCP runs as a Supabase Edge Function (`/functions/v1/mcp`) using the HTTP transport, in the user's Supabase Cloud project.
- **AI brain.** Default path = user's Claude Code / Desktop subscription via the remote MCP. BYOK Anthropic key still optional for the deployed edge functions' AI calls.

## Open questions to resolve when writing the spec

- **MCP port effort.** `mcp/src/index.ts` is ~2,100 LOC of Node + `pg.Pool` + stdio transport. The port to Deno + `deno-postgres` (or `@supabase/supabase-js`) + HTTP transport is the dominant cost of Tier 3. Decide between `deno-postgres` (preserves SQL idiom) and `@supabase/supabase-js` (PostgREST, more idiomatic Supabase) before writing the plan.
- **`transcribe_memory` in Tier 3.** Today it spawns local `whisper.cpp` via `child_process`. Options: drop in phase 1; route to a cloud transcription API (OpenAI Whisper, AssemblyAI); keep one tiny local helper. Probably drop in phase 1.
- **Auth model for remote MCP.** Static bearer token in `.env` (single-user, simple) vs OAuth (more standard, more work). Start with bearer; revisit if multi-user emerges.
- **Watch task scheduling.** Today watches run via a local scheduler. On Tier 3, use `pg_cron` (Supabase Cloud supports it) or scheduled Edge Functions.
- **Photo serving.** Supabase Storage public bucket vs signed URLs. Match the current `memory-image` proxy semantics (single-user; signed URLs are belt-and-braces).
- **Web app in Tier 3.** Phase 1: skipped. Phase 2: point existing `dbClient/tier1.ts` at Supabase Cloud (no extra adapter needed; the web app already speaks PostgREST + Storage REST).

## Pointers

- Tier model: [`../../TIERED_DEPLOYMENT_MODEL.md`](../../TIERED_DEPLOYMENT_MODEL.md).
- Tier 2 brainstorm (this session, in progress): `2026-05-16-tier-2-external-postgres-design.md` (forthcoming).
- Connection-string abstraction (the design Tier 3 builds on): [`2026-05-14-plannen-storage-tiers-design.md`](./2026-05-14-plannen-storage-tiers-design.md).
