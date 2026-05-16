# Tier 2 — Vercel hosting (Phase B.2)

**Date:** 2026-05-16
**Type:** Build & deploy pipeline (Tier 2 web hosting)
**Status:** Implemented in the same branch as Phase B.1 at user request.

## Problem

Phase B.1 ships Tier 2 with cloud Supabase + cloud MCP, but the web app still runs from the user's laptop (`npm run dev`). The original Tier 2 driver was "access from any device" — for true any-browser access we need the web app hosted on the open internet.

## Decision

Add a one-shot Vercel deploy path that:

1. Generates a minimal `vercel.json` (framework auto-detect for Vite + SPA rewrite).
2. Reads the Tier 2 `.env` to discover the keys Vercel needs (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PLANNEN_TIER`, `VITE_PLANNEN_BACKEND_MODE`).
3. Pushes those env vars into the Vercel project (production target) via `vercel env add` over stdin — non-interactive.
4. Triggers `vercel --prod` and parses the deployment URL from stdout.
5. Prints a post-deploy checklist for the two manual steps the CLI can't safely automate: updating Supabase Auth Site URL + Redirect URLs to the new Vercel origin.

The flow is a separate script `scripts/vercel-deploy.sh` (and `scripts/lib/vercel-deploy.mjs`) — **not** a `bootstrap.sh --vercel` flag. Two reasons: (1) Tier 2 + Vercel are independently re-runnable; (2) the bootstrap is already complex.

## Components

| File | Change |
|---|---|
| `vercel.json` *(new)* | Framework: Vite. Build command: `npm run build`. Output: `dist`. SPA rewrite (`/*` → `/index.html`) so deep links don't 404 on refresh. |
| `.vercelignore` *(new)* | Skip `node_modules`, `supabase/`, `mcp/`, `backend/`, tests, snapshots, dotfiles. |
| `scripts/lib/vercel-deploy.mjs` *(new)* | Pure helpers + `run(ctx, deps)`: scan `.env` for VITE_* + PLANNEN_* keys, push to Vercel non-interactively via stdin, trigger `vercel --prod`, parse the production URL. |
| `scripts/vercel-deploy.sh` *(new)* | Shell wrapper. Verifies Tier 2 (`PLANNEN_TIER=2` in `.env`), vercel CLI + login, then calls the orchestrator and prints the post-deploy checklist. |
| `tests/scripts/vercel-deploy.test.ts` *(new)* | Unit tests for the helpers + an end-to-end orchestrator test with stubbed `vercel` CLI. |
| `README.md` | Phase B.2 section after the Tier 2 setup section. |

## Why not Management API for Auth settings?

Supabase Auth's `site_url` + `additional_redirect_urls` are settable via the Management API (`PATCH /v1/projects/{ref}/config/auth`), but it needs `SUPABASE_ACCESS_TOKEN` (the user's personal token, distinct from project keys). For B.2 the cost/benefit doesn't justify wiring a third credential. The script prints a clear two-step dashboard link instead. Future B.2.1 can automate.

## Out of scope

- Custom domain configuration (user does this in Vercel + Supabase dashboards).
- Storage bucket CORS (`supabase-js` storage operations are origin-permissive by default).
- Preview deployments per branch (Vercel does this automatically once linked).
- Edge function CORS (not used by the web app — MCP is hit by Claude Code, not the browser).

## Pointers

- [`./2026-05-16-tier-2-cloud-deploy-design.md`](./2026-05-16-tier-2-cloud-deploy-design.md) — Phase B.1.
- Vercel CLI [env add](https://vercel.com/docs/cli/env), [`deploy`](https://vercel.com/docs/cli/deploy).
