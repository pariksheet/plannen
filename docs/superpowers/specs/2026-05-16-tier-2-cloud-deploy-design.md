# Tier 2 — Self-Hosted Cloud (Phase B.1)

**Date:** 2026-05-16
**Type:** Backend architecture / bootstrap & migration (Tier 2)
**Status:** Drafted; user approved sections 1–6, sections 7–8 added inline. Implementation kicked off in the same session.

## Problem

Phase A ported the Plannen MCP server to a Supabase Edge Function (`supabase/functions/mcp/`) that speaks `StreamableHTTPServerTransport` over HTTP. It runs locally via `supabase functions serve mcp`. Phase A explicitly defers cloud deploy:

> Phase B — Tier 2 cloud deploy. Bootstrap + migration scripts that `supabase functions deploy mcp` + the rest of the stack to a user's Supabase Cloud project. Uses the function built in this Phase A spec verbatim.
> — `docs/superpowers/specs/2026-05-16-tier-1-mcp-edge-function-design.md`

This spec is **Phase B.1**: stand up the user's Supabase Cloud project (DB + Auth + Storage + Edge Functions including the MCP), migrate Tier 1 → Tier 2 data and photos, and rewire the local laptop's `.env` + `plugin.json` to point at cloud. The web app continues to run locally (`npm run dev`) for now — Phase B.2 (separate spec) will move it to Vercel.

The driving user need: **access Plannen data from any device that has my laptop with it.** The cloud is the data plane; the laptop is the control plane.

## Decision

Add `--tier 2` to `scripts/bootstrap.sh` with a Tier 1 → Tier 2 migration path that mirrors the discipline of the recent Tier 0 → Tier 1 work (`scripts/lib/migrate-tier0-to-tier1.mjs`): **snapshot first, push schema, copy DB data, upload photos via Storage REST, deploy edge functions, set secrets, rewrite local `.env` + `plugin.json`.** Single user. MCP bearer auth (same shape as Phase A's HTTP mode), now exposed over the open internet — bearer is rotateable via a new helper. Phase A's MCP function is deployed **verbatim**; no second port.

**Tier scoping.** Phase B.1 covers Tier 1 → Tier 2. A "fresh Tier 2" install (no prior local Tier 1 data) is a thin code path that skips the data and photo steps. Tier 0 → Tier 2 directly is **not** supported in B.1 — users on Tier 0 first move to Tier 1 (already works), then Tier 2.

**Auth model.** Web app uses cloud Supabase Auth (magic link to `PLANNEN_USER_EMAIL`); RLS already filters by `auth.uid()`. MCP function authenticates with a 32-byte random bearer (constant-time compare, identical to Phase A) and sets `request.jwt.claim.sub` GUC via `withDb` for the resolved single user. Multi-user is out of scope (deferred to a later phase that introduces `plannen.api_tokens`, per Phase A's future-work section).

## Architecture

```
┌─── Tier 1 (today, unchanged) ────────────────────┐
│ Claude Code → plannen plugin                     │
│   ↓ stdio  OR  ↓ HTTPS loopback + bearer         │
│ node mcp/dist/index.js   OR   functions/mcp      │
│   ↓ pg                                           │
│ Supabase Docker (pg + storage + functions)       │
│ npm run dev → http://localhost:4321 → Docker     │
└──────────────────────────────────────────────────┘

┌─── Tier 2 (this spec) ───────────────────────────────────────────┐
│ Local laptop                          │  Supabase Cloud project   │
│ ───────────                           │  ───────────              │
│ Claude Code → plannen plugin          │                           │
│   ↓ HTTPS + bearer ───────────────────┼──→ functions/v1/mcp       │
│                                       │       ↓ Supavisor pool    │
│ npm run dev → http://localhost:4321   │  pg (cloud)               │
│   ↓ supabase-js (cloud anon key) ─────┼──→ REST + auth + storage  │
│                                       │  event-photos bucket      │
│                                       │  user_settings.anthropic_*│
└──────────────────────────────────────────────────────────────────┘
```

Three load-bearing properties:

1. **MCP function is the Phase A code, deployed.** No new port; `supabase functions deploy mcp` ships it. The Deno tests in `supabase/functions/mcp/tools/*.test.ts` already cover SQL semantics.
2. **`_shared/db.ts` already uses pooler-friendly URL.** In cloud, `SUPABASE_DB_URL` env var auto-points at Supavisor — same `pg.Pool` + `withDb` pattern keeps working.
3. **RLS still does the work.** Web app sends real JWTs (cloud Supabase Auth, magic-link). MCP function overrides `request.jwt.claim.sub` GUC via `withDb`, same as Tier 1 HTTP. **No schema changes.**

The bulk of this spec is the migration orchestrator. Deploying functions and pushing schema is well-trodden Supabase CLI. The Plannen-specific work is repeating the Tier 0→1 pattern one tier up.

## Components

| File / area | Change |
|---|---|
| `scripts/bootstrap.sh` | Add `--tier 2` arg. Add Tier 1→2 detection alongside the existing Tier 0→1 detection. Routes to the new orchestrator when `OLD_TIER=1 && TIER=2`. |
| `scripts/lib/migrate-tier1-to-tier2.mjs` *(new)* | Orchestrator: snapshot Tier 1 → link cloud → `db push` → restore data → upload photos → deploy functions → set secrets → rewrite local `.env` + `plugin.json` → verify. Idempotent and resumable via `.plannen-tier2-progress`. |
| `scripts/lib/cloud-link.mjs` *(new)* | Wraps `supabase link --project-ref <ref>` and `supabase login` checks. Prompts for project ref if not set; persists in `.env`. Reads cloud anon + service-role keys via `supabase status --output json`. |
| `scripts/lib/cloud-deploy.mjs` *(new)* | Iterates `supabase/functions/*`, runs `supabase functions deploy <name>` for each. The `mcp` function gets `--no-verify-jwt` (it has its own bearer). Runs `supabase secrets set` for function-side env: `PLANNEN_USER_EMAIL`, `MCP_BEARER_TOKEN`, Google OAuth client id/secret. |
| `scripts/lib/storage-cloud-upload.mjs` *(new)* | Lists local `event-photos` bucket via Storage REST against the Docker stack, downloads each object, uploads to cloud bucket. HEAD-precheck on cloud skips already-uploaded objects. Per-object retry with backoff. Total-size precheck warns at >1 GB (Supabase free-tier limit). |
| `scripts/lib/migrate.mjs` | Add a Tier 2 path that runs `supabase db push` against the linked project. Forward-only migrations from `supabase/migrations/` push cleanly. Tier 0 overlay (`supabase/migrations-tier0/`) is skipped for Tier 1+ (cloud has `auth.*` / `storage.*` already). |
| `scripts/cloud-doctor.mjs` *(new, or as a Tier 2 mode of plannen-doctor)* | Verifies: cloud reachable; MCP function `tools/list` returns ≥40 tools; photo counts match Tier 1; plugin.json points at cloud URL with valid bearer; `auth.users` row exists for `PLANNEN_USER_EMAIL`. |
| `scripts/mcp-rotate-bearer.sh` *(new)* | Generates a new 32-byte bearer, runs `supabase secrets set MCP_BEARER_TOKEN=...`, rewrites local `.env` + `plugin.json`, tells the user to reload the plannen plugin in Claude Code. |
| `plugin/.claude-plugin/plugin.json` | Rewritten by Tier 2 bootstrap to `{ "type": "http", "url": "https://<ref>.supabase.co/functions/v1/mcp", "headers": { "Authorization": "Bearer <token>" } }`. The git-checked-in version stays stdio. |
| `.env` | Gains `PLANNEN_TIER=2`, `SUPABASE_PROJECT_REF=<ref>`, `VITE_SUPABASE_URL` (cloud), `VITE_SUPABASE_ANON_KEY` (cloud), `MCP_BEARER_TOKEN`. Cloud service-role key is written but never read by the web app. |
| `.env.tier1.bak`, `plugin.json.tier1.bak` *(new files, gitignored)* | Written at Step 7 to support reverse migration (`bootstrap.sh --tier 1` after a Tier 2 install). |
| `supabase/functions/mcp/`, `supabase/functions/_shared/db.ts` | **Unchanged.** Phase A code deploys as-is. |
| `supabase/functions/google-oauth-callback/` | **No code change.** Bootstrap prints the new callback URL (`https://<ref>.supabase.co/functions/v1/google-oauth-callback`) and instructs the user to add it to their Google Cloud OAuth client. Doctor verifies the function endpoint resolves. |
| `tests/integration/tier2-bootstrap.test.ts` *(new, gated)* | Gated by `RUN_TIER2_INTEGRATION=1`; runs the full bootstrap against a throwaway cloud project specified by `TIER2_TEST_PROJECT_REF`. Not in default CI. |
| `tests/smoke/tier2-bootstrap.sh` *(new)* | Bash smoke covering end-to-end including a real MCP `list_events` call over HTTPS. |
| `README.md`, `CONTRIBUTING.md` | Tier 2 install + migration sections. |
| `.gitignore` | `.env.tier1.bak`, `plugin.json.tier1.bak`, `.plannen-tier2-progress`, `.tier2-uploaded.txt`. |

Two things left out on purpose:

- **No new edge function.** MCP function from Phase A is the only one this spec adds to the *deployed* set; the others (agent-discover, agent-scrape, picker-session-*, etc.) already exist and just need `functions deploy`.
- **No schema migrations.** Same `plannen.*` schema, forward-only.

## Data flow — bootstrap & migration

Trigger: `bash scripts/bootstrap.sh --tier 2` with `.env` showing `PLANNEN_TIER=1` → `TIER_CHANGE="1->2"` routes through the orchestrator.

```
Step 0 — Prereqs
  • supabase CLI present (else: install instructions)
  • `supabase login` authed (else: prompt)
  • If Tier 1 active: `supabase start` is running (else: fail fast)

Step 1 — Snapshot Tier 1
  scripts/lib/snapshot.mjs (existing)
  • dumps plannen.* tables → ~/.plannen/snapshots/tier1-<ts>.sql
  • tars event-photos bucket → tier1-<ts>-photos.tar.gz
  • prints rollback command

Step 2 — Cloud link
  scripts/lib/cloud-link.mjs
  • read SUPABASE_PROJECT_REF from .env if present, else prompt
  • `supabase link --project-ref <ref>`
  • write SUPABASE_PROJECT_REF + cloud anon + service_role to .env

Step 3 — Push schema
  scripts/lib/migrate.mjs --tier 2
  • `supabase db push` (forward-only)

Step 4 — Restore data
  scripts/lib/migrate-tier1-to-tier2.mjs
  • psql against cloud SUPABASE_DB_URL inside a single transaction:
      DISABLE TRIGGER ALL → \copy in topo order → ENABLE TRIGGER ALL
  • Idempotent guard: aborts if cloud plannen.events has rows
    unless --force-overwrite is set

Step 5 — Upload photos
  scripts/lib/storage-cloud-upload.mjs
  • size precheck (warn at >1 GB)
  • for each object: GET local → POST cloud (Storage REST)
  • HEAD precheck on cloud → skip already-uploaded
  • count-parity check at end

Step 6 — Deploy functions + set secrets
  scripts/lib/cloud-deploy.mjs
  • generate MCP_BEARER_TOKEN if absent
  • `supabase secrets set` (PLANNEN_USER_EMAIL, MCP_BEARER_TOKEN,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, …)
  • `supabase functions deploy mcp --no-verify-jwt`
  • `supabase functions deploy <each-other-function>`

Step 7 — Rewrite local config
  • back up .env → .env.tier1.bak, plugin.json → plugin.json.tier1.bak
  • write .env (PLANNEN_TIER=2, cloud URLs/keys, bearer)
  • write plugin.json (HTTP mode pointing at cloud)

Step 8 — Verify
  scripts/cloud-doctor.mjs
  • curl cloud /functions/v1/mcp tools/list with bearer → ≥40 tools
  • row counts match snapshot
  • photo counts match
  • prints next-steps banner
```

**Fresh `--tier 2` (no prior Tier 1 data) variant.** Steps 1, 4, 5 are no-ops. Steps 2, 3, 6, 7, 8 run unchanged.

**Resumability.** Each step writes a marker to `.plannen-tier2-progress` (gitignored). Re-running `bootstrap.sh --tier 2` skips completed steps; doctor at Step 8 re-verifies regardless.

**Rollback story.** Tier 1 snapshot at Step 1 is the safety net. `.env.tier1.bak` + `plugin.json.tier1.bak` at Step 7. A user running `bootstrap.sh --tier 1` after a Tier 2 install gets a reverse path that restores the backups without touching the cloud project.

## Schema changes

**None.** The cloud DB receives the existing `supabase/migrations/` set forward-only. No new tables, no new RLS policies. Phase A's note that multi-user MCP would add `plannen.api_tokens` is *not* this spec.

## Error handling

| Failure mode | Behavior |
|---|---|
| `supabase` CLI not installed | Fail at Step 0 with install command. No state written. |
| `supabase login` not authed | Fail at Step 0; prompt to run `supabase login`. |
| Tier 1 Docker not running when migrating from Tier 1 | Fail at Step 0. Don't auto-start Docker — user's call. |
| `SUPABASE_PROJECT_REF` unknown / typo | Step 2 verifies via `supabase projects list`; rejects unknown ref. |
| `supabase db push` migration error | Step 3 aborts. Don't auto-`db reset` (hard rule). Print remediation. |
| Cloud `plannen.events` already has rows at Step 4 | Abort with `cloud db non-empty; pass --force-overwrite to confirm`. |
| `psql` data restore fails mid-way | Wrapped in single `BEGIN..COMMIT`; partial state rolls back. Re-run is safe. |
| Photo upload partial failure | Per-object retry × 3 with backoff. Successful keys logged to `.tier2-uploaded.txt`. Re-run skips via HEAD precheck. Final parity check surfaces the gap. |
| Photo bucket > 1 GB | Warn, require `--accept-storage-quota` or `--skip-photos`. |
| `supabase functions deploy mcp` fails | Step 6 aborts before deploying the rest, so the user isn't left pointing at a broken MCP. |
| `supabase secrets set` fails | Step 6 aborts; doctor flags missing secrets. |
| Bearer leaked / rotation needed | `scripts/mcp-rotate-bearer.sh` runs a single rotation: new token → `supabase secrets set` → rewrite local `.env`+`plugin.json` → reload-plugin instructions. |
| Bootstrap re-run after partial success | `.plannen-tier2-progress` markers skip completed steps. Doctor re-verifies regardless. |
| User runs `bootstrap.sh --tier 1` after Tier 2 | Reverse path: restore `.env.tier1.bak`+`plugin.json.tier1.bak`; cloud project untouched; print "cloud project still exists; not synced back". |
| Network drops during photo upload | Per-object resumable via HEAD precheck + retries. |
| Doctor at Step 8 finds MCP `tools/list` empty | Print missing tools, suggest `supabase functions logs mcp`. No auto-fix. |

**Invariant.** Each `scripts/lib/*.mjs` module exports a pure `run(ctx)` that takes and returns the bootstrap context; no global state; no `process.exit` inside libs. The shell wrapper makes exit decisions. Same shape as `migrate-tier0-to-tier1.mjs`.

## Testing

| Layer | What | Where |
|---|---|---|
| **Unit (Node, vitest)** | Per-lib tests with the `supabase` CLI mocked as a shell-exec stub (capture invocations, assert args). Storage REST mocked. Covers tier-change detection, progress-marker resume, size precheck, count-parity check, rotation flow, reverse-migration restore. | `npm test` (default CI). |
| **Integration (gated)** | Spin up Tier 1 Docker, seed with fixtures, run the full bootstrap against a throwaway cloud project (`TIER2_TEST_PROJECT_REF`). Asserts schema applied, row/photo counts match, MCP `tools/list` ≥40 over the cloud URL, `plugin.json` rewrite correct. Cleanup clears `plannen.*` only (not `db reset`). Gated by `RUN_TIER2_INTEGRATION=1`. | `tests/integration/tier2-bootstrap.test.ts`. |
| **Smoke (manual / pre-PR)** | `tests/smoke/tier2-bootstrap.sh` — full bootstrap + doctor + a real `list_events` MCP call over HTTPS. | Bash. |

**What's out of default CI.** Anything that hits a real cloud project. Maintainer runs the gated tests manually.

**One subtle test worth writing.** Reverse path: given Tier 2 state, `bootstrap.sh --tier 1` must restore `.env.tier1.bak`+`plugin.json.tier1.bak` without contacting the cloud project. Easy to forget, expensive to discover in a real rollback.

Phase A's existing Deno tests for `supabase/functions/mcp/tools/*` stay alive and are not re-proved here.

## Out of scope (Phase B.1)

- **Vercel hosting (Phase B.2).** Local `npm run dev` against cloud is sufficient for B.1. B.2 adds the build pipeline, env-var management, custom domain, CORS on the storage bucket.
- **Multi-user.** Single bearer + single `auth.users` row. `plannen.api_tokens` migration is its own spec.
- **Tier 0 → Tier 2 fast path.** Users on Tier 0 first move to Tier 1, then to Tier 2. Two hops, both already supported individually.
- **Two-way sync between Tier 1 and Tier 2.** Out of scope; flagged as explicitly ruled-out.
- **Cloud-API transcription** to replace the Node-only `transcribe_memory`. Same Phase A asymmetry: tool is absent from the cloud MCP. Deferred until there's real demand.
- **Custom domain on the Supabase project.** Default `*.supabase.co` is fine for B.1. Users can wire a custom domain via Supabase's UI without code changes.
- **Telemetry / cost dashboards.** No usage tracking, no quota alerts beyond the photo-size warning.

## Future work

- **Phase B.2 — Vercel hosting.** Build pipeline, `.env.production` injection, Supabase Storage CORS for the deployed origin, optional custom domain. Login UX on the open internet (magic link only; no password). Lives at `docs/superpowers/specs/<date>-tier-2-vercel-hosting-design.md`.
- **Multi-user MCP** (Phase A.1 in the prior spec). `plannen.api_tokens` + middleware token→user resolution. Web UI for token mint/rotate.
- **Custom domain helper.** `scripts/cloud-domain.sh add <domain>` — wraps the Supabase API for the custom-domain assignment. Trivial once needed.
- **Cloud transcription.** Replace dropped `transcribe_memory` via OpenAI Whisper / AssemblyAI / future Anthropic audio API.
- **Tier 2 → Tier 1 carry-back.** A real reverse migration (cloud DB + photos back into Docker), not just config-restore. Useful if the user wants to develop against cloud data offline.

## Open questions / risks

- **MCP bearer on the open internet.** Phase A's bearer model was loopback-only. Tier 2 exposes it to the public Supabase Edge Function URL. Mitigations: 32-byte random bearer, constant-time compare (already in Phase A), `.env`+`plugin.json` gitignored, easy rotation (`scripts/mcp-rotate-bearer.sh`). Risk accepted for single-user; revisit when multi-user lands.
- **`pg.Pool` under Supabase Edge Functions in cloud.** Phase A flagged this risk locally; cloud is more important due to cold starts. Mitigation: rely on Supavisor (the cloud `SUPABASE_DB_URL` auto-points at it); cap `Pool` size; surface clean errors on exhaustion. Revisit if MCP function actually hits the cap.
- **Supabase free-tier quotas.** 500 MB DB, 1 GB storage, 500K Edge Function invocations / month. Bootstrap warns at >1 GB photo bucket. DB is well under for any reasonable Plannen install. Function invocations are a non-issue at single-user usage.
- **Google OAuth callback registration.** The cloud function URL must be added to the user's Google Cloud OAuth client. No way to automate this from outside Google Cloud. Mitigation: bootstrap prints the exact URL prominently; doctor checks the function endpoint resolves.
- **Cloud project provisioning.** B.1 expects the user has already created the Supabase project in the dashboard. Auto-provisioning via `supabase projects create` is feasible but adds a billing-confirmation flow; not worth automating for one-time setup.
- **Schema drift from Tier 1 history.** Tier 1 has likely had migrations applied via `supabase db reset`-free flow over its life. `supabase db push` against a fresh cloud project re-applies all migrations cleanly. Risk: if a Tier 1 user has hand-modified their local schema outside of the migration files, `db push` won't reflect that. Mitigation: doctor's count check would catch row-shape mismatches; spec recommends running Tier 1 doctor before initiating the migration.
- **Bearer in `plugin.json` accidentally committed.** Phase A already covered the gitignore. Re-affirm in this spec's gitignore additions.

## Pointers

- Tier ladder: [`../../TIERED_DEPLOYMENT_MODEL.md`](../../TIERED_DEPLOYMENT_MODEL.md).
- Phase A (MCP as edge function): [`./2026-05-16-tier-1-mcp-edge-function-design.md`](./2026-05-16-tier-1-mcp-edge-function-design.md).
- Tier 0→1 migration this spec models on: [`./2026-05-16-tier0-to-tier1-migration-and-auto-snapshot-design.md`](./2026-05-16-tier0-to-tier1-migration-and-auto-snapshot-design.md).
- Existing Tier 0→1 orchestrator: [`../../../scripts/lib/migrate-tier0-to-tier1.mjs`](../../../scripts/lib/migrate-tier0-to-tier1.mjs).
- Snapshot helper: [`../../../scripts/lib/snapshot.mjs`](../../../scripts/lib/snapshot.mjs).
- MCP edge function: [`../../../supabase/functions/mcp/`](../../../supabase/functions/mcp/).
- Bootstrap script: [`../../../scripts/bootstrap.sh`](../../../scripts/bootstrap.sh).
- MCP HTTP transport reference: [Model Context Protocol — Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http).
- Supabase CLI reference: [`supabase link`](https://supabase.com/docs/reference/cli/supabase-link), [`db push`](https://supabase.com/docs/reference/cli/supabase-db-push), [`functions deploy`](https://supabase.com/docs/reference/cli/supabase-functions-deploy), [`secrets set`](https://supabase.com/docs/reference/cli/supabase-secrets-set).
