# Plannen — Claude context

Workflow logic — event-creation intent gate, passive profile extraction, watch monitoring, stories, photos, discovery, source analysis — lives in the project plugin at [`./plugin/`](./plugin/). The plugin loads automatically when installed (`bootstrap.sh` handles install). Don't duplicate that logic here or in code.

## Hard rules

- **Never wipe user data.** Apply migrations with `node scripts/lib/migrate.mjs` in Tier 0 or `supabase migration up` in Tier 1. Back up first via `bash scripts/export-seed.sh` (Tier 1, dumps DB + photos tarball) or by tarring `~/.plannen/pgdata + ~/.plannen/photos` (Tier 0).
- **Never run `supabase db reset`.** Even in Tier 1 it wipes user data. Use `export-seed.sh` first or apply forward-only migrations.
- **Tier-aware bootstrap.** `bash scripts/bootstrap.sh` defaults to Tier 0 (embedded Postgres, port 54322). `bash scripts/bootstrap.sh --tier 1` runs the existing local-Supabase path. See `docs/TIERED_DEPLOYMENT_MODEL.md`.
- **DB migrations are forward-only.** A single squashed initial schema lives at `supabase/migrations/00000000000000_initial_schema.sql` (consolidated 2026-05-12). Tier 0 adds a compat overlay at `supabase/migrations-tier0/` that runs *before* the main migrations to stub `auth.*`, `storage.*`, `extensions.*`, and the `postgres/anon/authenticated/service_role` roles. New changes go in additive timestamped migrations under `supabase/migrations/` on top.
- **Edge functions never read AI keys from request bodies.** Keys live in `user_settings` (one row per user, RLS-scoped) and are read server-side via `auth.uid()` in `supabase/functions/_shared/ai.ts`. Treat any request-body key path as a bug.
- **`list_events` defaults to `limit: 10` and silently truncates.** Always pass `limit: 50+` for agenda-style queries.
- **Dev port is `4321`, not `5173`.** Pinned in `vite.config.ts` with `strictPort: true`. A port-busy error is the intended failure mode.

## Pointers

- Schema migrations: `supabase/migrations/` (main) + `supabase/migrations-tier0/` (Tier 0 overlay).
- Migration runner: `scripts/lib/migrate.mjs` (tier-aware).
- MCP server: `mcp/src/index.ts` — now uses `pg.Pool` + `withUserContext` from `mcp/src/db.ts`.
- Embedded Postgres lifecycle: `scripts/pg-start.sh` / `scripts/pg-stop.sh` (wrappers around `scripts/lib/plannen-pg.mjs`). PID at `~/.plannen/pg.pid`, data at `~/.plannen/pgdata`.
- Edge functions: `supabase/functions/` — BYOK wrapper at `_shared/ai.ts` (Tier 1 only; Phase 2 swaps these for a Node backend).
- Plugin source: `plugin/skills/` (always-on rules) and `plugin/commands/` (slash commands).
- Design docs (approved brainstorms): `docs/superpowers/specs/`.
- Tier model: `docs/TIERED_DEPLOYMENT_MODEL.md`. Integration vs storage framing: `docs/INTEGRATIONS.md`.
- Human-facing setup + architecture: [`README.md`](./README.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md).
