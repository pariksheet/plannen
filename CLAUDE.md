# Plannen — Claude context

Workflow logic — event-creation intent gate, passive profile extraction, watch monitoring, stories, photos, discovery, source analysis — lives in the project plugin at [`./plugin/`](./plugin/). The plugin loads automatically when installed (`npx plannen init` handles install). Don't duplicate that logic here or in code.

## Hard rules

- **This repo is PUBLIC — never write personal data into it.** No real family names, calendar event titles, schools, clubs, addresses, employers, client contacts, or emails in any file: skills, docs, specs, tests, tool-description examples, commit messages. Use invented personas and generic examples ("Milo", "Weekly call", "example.org"). Real data belongs only in the user's DB/MCP layer, never in the working tree.
- **Never wipe user data.** Apply migrations with `npx plannen migrate` (tier-aware: Tier 0/1 via `scripts/lib/migrate.mjs`, Tier 2 via `supabase db push --project-ref`). Back up first via `bash scripts/export-seed.sh` (Tier 1, dumps DB + photos tarball) or by tarring `~/.plannen/pgdata + ~/.plannen/photos` (Tier 0).
- **Never run `supabase db reset`.** Even in Tier 1 it wipes user data. Use `export-seed.sh` first or apply forward-only migrations.
- **Tier-aware install.** `npx plannen init --mode=local_pg` is Tier 0 (embedded Postgres, port 54322). `--mode=local_sb` is Tier 1 (local Supabase Docker). `--mode=cloud_sb` is Tier 2 (Supabase Cloud). See `docs/TIERED_DEPLOYMENT_MODEL.md`.
- **Tier 0 daily workflow.** `npx plannen up` brings up embedded Postgres (54322) + backend (54323) + web dev (4321). `npx plannen down` stops them. Tier-aware dispatch lives in `cli/commands/up.mjs` and `cli/commands/down.mjs`; per-process scripts (`pg-start.sh`, `backend-start.sh`, `dev-start.sh`, `functions-start.sh`, `local-start.sh`) are what they call.
- **DB migrations are forward-only.** A single squashed initial schema lives at `supabase/migrations/00000000000000_initial_schema.sql` (consolidated 2026-05-12). Tier 0 adds a compat overlay at `supabase/migrations-tier0/` that runs *before* the main migrations to stub `auth.*`, `storage.*`, `extensions.*`, and the `postgres/anon/authenticated/service_role` roles. New changes go in additive timestamped migrations under `supabase/migrations/` on top.
- **Edge functions never read AI keys from request bodies.** Keys live in `user_settings` (one row per user, RLS-scoped) and are read server-side via `auth.uid()` in `supabase/functions/_shared/ai.ts`. Treat any request-body key path as a bug.
- **`list_events` defaults to `limit: 10` and silently truncates.** Always pass `limit: 50+` for agenda-style queries.
- **Dev port is `4321`, not `5173`.** Pinned in `vite.config.ts` with `strictPort: true`. A port-busy error is the intended failure mode.
- **Profiles own the active env.** `<repo>/.env` is a symlink to `~/.plannen/profiles/<active>/env`. The active profile is recorded at `~/.plannen/active` (or overridden per-shell via `PLANNEN_PROFILE`). Manage with `plannen profile {create,use,list,delete}`. PR1 verbs (`init`, `up`, `down`, `status`) accept `--profile <name>` to override. **Do not edit `.env` through the symlink expecting it to detach** — write to the profile env file directly.
- **Vercel deploy is `npx plannen deploy`** (replaced `scripts/vercel-deploy.sh`). Requires a `cloud_sb` profile. Auto-runs `vercel link --yes` if `.vercel/` is missing. Writes the stable alias back to `PLANNEN_WEB_URL`.
- **Synthetic profile mode** (`PLANNEN_PROFILE_FROM_ENV=1`) lets CI feed profile inputs through env vars instead of `~/.plannen/profiles/`. Same verbs, different inputs; no CI-specific branching inside the commands.
- **Cloud provision is `npx plannen cloud provision --profile <name>`.** 10-step guided setup for a fresh `cloud_sb` profile (Supabase project link + schema push + function deploy + Vercel link + env push + first deploy + Auth wiring). Idempotent / resumable via `.plannen-provision-<profile>-progress`. Requires the profile to exist (`plannen profile create`) before running.
- **Promote is `npx plannen promote`** (`--staging-profile`/`--prod-profile` override the `staging`/`prod` defaults). Replays staging's schema + edge functions + Vercel build against prod. Refuses if prod has migrations staging doesn't (drift). CI invokes the same code via `.github/workflows/promote-prod.yml` after the `prod-promote` Environment's manual approval.
- **The plannen MCP server has two implementations — keep them in sync.** `mcp/src/index.ts` is the local-mode (Tier 0) stdio server. `supabase/functions/mcp/` is the HTTP edge function — `plugin/.claude-plugin/plugin.json` points Claude Code at this one, so it's what every `mcp__plugin_plannen_plannen__*` call hits in Tier 1/2. **Any new tool must be added in BOTH places.** Steps: (1) register tool + handler in `mcp/src/index.ts`, (2) mirror it as a `ToolModule` under `supabase/functions/mcp/tools/<area>.ts` with matching schema/SQL, (3) import + add to the `TOOLS` array in `supabase/functions/mcp/index.ts`, (4) `npx plannen migrate` for any new tables on every active profile, (5) deploy the edge function (`supabase functions deploy mcp --project-ref <ref>` for cloud, or restart `npx plannen up` for Tier 1). A tool that exists only in `mcp/src/index.ts` will silently 404 in the live Claude Code session — symptom: tool appears in code/grep but not in `ToolSearch`.

## Pointers

- Schema migrations: `supabase/migrations/` (main) + `supabase/migrations-tier0/` (Tier 0 overlay).
- Migration runner: `scripts/lib/migrate.mjs` (tier-aware).
- MCP server (local/Tier 0): `mcp/src/index.ts` — uses `pg.Pool` + `withUserContext` from `mcp/src/db.ts`.
- MCP server (Tier 1/2, the one Claude Code actually talks to): `supabase/functions/mcp/` — modular `ToolModule` registry in `index.ts`, per-area tools under `tools/`. Bearer-token gated. Plugin pins its URL in `plugin/.claude-plugin/plugin.json`.
- Embedded Postgres lifecycle: `scripts/pg-start.sh` / `scripts/pg-stop.sh` (wrappers around `scripts/lib/plannen-pg.mjs`). PID at `~/.plannen/pg.pid`, data at `~/.plannen/pgdata`.
- Edge functions: `supabase/functions/` — BYOK wrapper at `_shared/ai.ts` (Tier 1 only; Phase 2 swaps these for a Node backend).
- Plugin source: `plugin/skills/` (always-on rules) and `plugin/commands/` (slash commands).
- Mailbox sync: launchd job at `~/Library/LaunchAgents/work.plannen.mailbox-sync.plist`. Logs at `~/.plannen/logs/mailbox-sync.log`. Manage via `npx plannen mailbox {install,uninstall}` and `/plannen-mailbox-rules`.
- Design docs (approved brainstorms): `docs/superpowers/specs/`.
- Tier model: `docs/TIERED_DEPLOYMENT_MODEL.md`. Integration vs storage framing: `docs/INTEGRATIONS.md`.
- Human-facing setup + architecture: [`README.md`](./README.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md).
