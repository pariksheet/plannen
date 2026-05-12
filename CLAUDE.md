# Plannen — Claude context

Workflow logic — event-creation intent gate, passive profile extraction, watch monitoring, stories, photos, discovery, source analysis — lives in the project plugin at [`./plugin/`](./plugin/). The plugin loads automatically when installed (`bootstrap.sh` handles install). Don't duplicate that logic here or in code.

## Hard rules

- **Never run `supabase db reset`.** It wipes user data. Apply migrations with `supabase migration up`. Back up first via `bash scripts/export-seed.sh`.
- **DB migrations are forward-only.** A single squashed initial schema lives at `supabase/migrations/00000000000000_initial_schema.sql` (consolidated 2026-05-12). New changes go in additive timestamped migrations on top.
- **Edge functions never read AI keys from request bodies.** Keys live in `user_settings` (one row per user, RLS-scoped) and are read server-side via `auth.uid()` in `supabase/functions/_shared/ai.ts`. Treat any request-body key path as a bug.
- **`list_events` defaults to `limit: 10` and silently truncates.** Always pass `limit: 50+` for agenda-style queries.
- **Dev port is `4321`, not `5173`.** Pinned in `vite.config.ts` with `strictPort: true`. A port-busy error is the intended failure mode.

## Pointers

- Schema migrations: `supabase/migrations/`.
- MCP server: `mcp/src/index.ts` (single TypeScript file wrapping the Supabase service-role client).
- Edge functions: `supabase/functions/` — BYOK wrapper at `_shared/ai.ts`.
- Plugin source: `plugin/skills/` (always-on rules) and `plugin/commands/` (slash commands).
- Design docs (approved brainstorms): `docs/superpowers/specs/`.
- Human-facing setup + architecture: [`README.md`](./README.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md).
