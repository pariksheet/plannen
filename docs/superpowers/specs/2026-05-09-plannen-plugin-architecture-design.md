# Plannen Claude Code Plugin — Architecture Design

**Date:** 2026-05-09
**Status:** Design approved; pending spec review and implementation plan
**Branch:** feat/tier-1-opensource

## Context

Plannen is being prepared for open-source release. Today the project ships:

- A React + Vite web app at `src/`
- A Supabase backend (`supabase/migrations/`, `supabase/functions/`)
- An MCP server at `mcp/` (TypeScript source at `mcp/src/`; `dist/` is gitignored)
- A 250-line `CLAUDE.md` at repo root containing the Claude-Code-facing workflow logic (event creation intent gate, profile building, watch monitoring, story composition, photo organisation, source analysis, discovery, DB-migration safety)

The Claude Code surface today consists of: a project-scoped `.mcp.json` (which hardcodes `PLANNEN_USER_EMAIL=you@example.com`) plus the workflow procedures in `CLAUDE.md`. Most of Plannen's *intelligence* — the conversational rules, the workflow steps, the safety guardrails — lives in `CLAUDE.md`, not in MCP tool implementations. Anyone cloning the repo today gets the tools but loses the rules unless they read `CLAUDE.md` end-to-end.

For OSS release, the Claude Code surface must become installable as a single unit so that every user gets the workflows automatically. The chosen mechanism is a **Claude Code plugin** that bundles: the MCP server registration, the workflow skills, slash commands, and (eventually) hooks/routines. Three alternatives were considered:

1. Status-quo: keep project-scoped `.mcp.json` + `CLAUDE.md`. Users edit JSON post-clone and read `CLAUDE.md`. Rejected: too much friction; workflows aren't packaged.
2. MCP-only npm package. Users install the MCP server but skill content stays in `CLAUDE.md`. Rejected: doesn't ship the workflows.
3. **Claude Code plugin** (chosen). Users run one install command and get tools + skills + commands.

This document specifies the plugin architecture for V1.

## Goals & non-goals

### Goals

- An OSS user can clone the plannen repo, run one bootstrap command, and have a working Plannen + Claude Code stack on their machine, configured for their identity, in under 10 minutes.
- The Claude Code workflow logic that today lives in `CLAUDE.md` ships as plugin skills, so it loads for every user without requiring them to read project documentation.
- The plugin and the underlying app version together (single repo, single PR for cross-cutting changes).
- The plugin is forward-compatible with later tiers (Tier 4 hosted Plannen) without a rewrite.

### Non-goals

- Multi-user MCP support. The MCP remains single-user-per-instance (one `PLANNEN_USER_EMAIL` per `.env`). Multi-user is a Tier 4 concern.
- Hosted Plannen support. V1 plugin assumes Tier 1 (local Supabase, local app, BYOK AI).
- Marketplace publication. V1 ships as `/plugin install ./plugin` (local-path install). Marketplace listing is a future concern.
- BYOK abstraction details. The plugin design accommodates BYOK (`ANTHROPIC_API_KEY` slot in `.env`) but doesn't specify how edge functions read per-request keys. Separate brainstorm.
- Time-triggered automation via Claude Code hooks. Watch monitoring will run as a Claude routine (`/schedule`) instead. Plugin V1 ships no hooks.

## Architecture decisions

The brainstorm settled six foundational choices. These are load-bearing — changing any of them ripples through the rest of the design.

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Plugin scope vs app | Thin Claude Code interface; assumes user has run bootstrap and the app is up. | Lifecycle manager (plugin starts/stops Supabase); self-contained mega-bundle (plugin ships the entire app). |
| Plugin location | Inside plannen repo at `./plugin/`. Installed via `/plugin install ./plugin`. | Separate repo `plannen-claude-plugin`; co-located + mirrored read-only repo. |
| Workflow trigger model | Skills + slash commands (both work; commands are thin wrappers for discoverability). | Skills only (no commands); commands only (no natural-language path). |
| Time-triggered automation | None in V1. Watch monitoring will be a Claude cloud routine, designed post-V1. | SessionStart hook (CLI-injected context); SessionStart hook (agent-nudge). |
| Skill granularity | One core skill (always-on rules) + per-workflow skills (load on intent match). | One mega-skill `plannen.md`; minimal skills with logic in a `CLAUDE.md` template. |
| MCP source location | Repo-level `mcp/`. Plugin references `../mcp/dist/index.js` from `${CLAUDE_PLUGIN_ROOT}`. | Move into `plugin/mcp/`; thin proxy in `plugin/mcp/`. |

## Repository layout

```
plannen/
├── src/                          # React app (unchanged)
├── supabase/                     # Migrations, edge functions, seed templates
├── mcp/
│   ├── src/                      # TypeScript source (already exists)
│   ├── dist/                     # Build output (gitignored)
│   ├── package.json              # Own package, builds via tsc (already exists)
│   └── tsconfig.json
├── plugin/                       # NEW — Claude Code plugin
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/
│   │   ├── plannen-core.md
│   │   ├── plannen-stories.md
│   │   ├── plannen-photos.md
│   │   ├── plannen-discovery.md
│   │   ├── plannen-watches.md
│   │   └── plannen-sources.md
│   ├── commands/
│   │   ├── plannen-setup.md
│   │   ├── plannen-doctor.md
│   │   ├── plannen-write-story.md
│   │   ├── plannen-organise-photos.md
│   │   ├── plannen-discover.md
│   │   ├── plannen-check-watches.md
│   │   └── plannen-backup.md
│   └── README.md
├── scripts/
│   ├── bootstrap.sh              # NEW — one-command setup
│   └── export-seed.sh            # Existing
├── docs/
├── .env.example                  # NEW — template for the per-project .env
├── .mcp.json.example             # Template (replaces committed .mcp.json)
└── README.md                     # NEW — root README pointing at bootstrap
```

Key constraints this layout enforces:

- The plugin's MCP reference resolves correctly because `${CLAUDE_PLUGIN_ROOT}` walks up to repo root via `..`. This works for path installs (`/plugin install ./plugin`). If the plugin is ever published standalone (marketplace), this path needs to change — flagged in Backlog.
- `mcp/` becomes its own npm workspace package, so it builds independently and could later publish to npm.
- `plugin/` is self-contained except for the relative-path MCP reference and the relative read of `.env` (handled by the MCP itself, see Configuration).
- `.mcp.json` was never committed (it is per-machine and contains the maintainer's email). `.mcp.json.example` is kept as the template for users who want direct Claude Desktop integration without installing the plugin.

## Plugin manifest

`plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "plannen",
  "version": "0.1.0",
  "description": "Family event planning, watches, stories, and photo organisation for the Plannen app.",
  "author": { "name": "<owner>", "url": "https://github.com/<owner>/plannen" },
  "homepage": "https://github.com/<owner>/plannen",
  "license": "<chosen-license>",
  "mcpServers": {
    "plannen": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js"]
    }
  }
}
```

The manifest is intentionally minimal. No env block, no `${VAR}` substitution — the MCP server self-loads its configuration from `<repo-root>/.env` at startup. This avoids forcing users to manage shell environment variables and keeps all configuration in one human-editable file.

The MCP server locates `.env` deterministically: `dist/index.js` resolves `__dirname` to `<repo-root>/mcp/dist/`, so `path.resolve(__dirname, '../../.env')` always points at the project's root `.env`. The MCP loads it via `dotenv` before any tool is registered. This works regardless of the cwd at MCP launch time, which is the failure mode it's designed around (Claude Code launches MCP processes from arbitrary cwds).

`<owner>`, `<chosen-license>`, and the repo URL are filled in at OSS-release time.

## Skill inventory

Six skills total. One core (always-on rules), five workflow-specific (load on intent match).

### `plannen-core.md` — always-on rules

- **Triggers on:** any plannen MCP tool call or any conversation referencing plannen events / family / profile.
- **Migrated content from CLAUDE.md:**
  - Event creation intent gate (brainstorm-vs-commit detection before `create_event`).
  - Profile building passive extraction (durability filter, when to `upsert_profile_fact` silently, corrections).
  - Source-analysis post-trigger (after `create_event` with an `enrollment_url`, fetch the returned `source` and call `update_source` if `last_analysed_at` is null).
  - DB migration safety (never `db reset`; use `migration up`; back up first via `scripts/export-seed.sh`).

### `plannen-stories.md` — story creation & editing

- **Triggers on:** "write a story about", "make a story", "tell me about [past event]", or any explicit story-creation request.
- **Migrated content:** the 7-step CLAUDE.md story workflow (resolve target → load memories → ask for input → sample photos → compose → persist → report) plus the editing path (`update_story` for tweaks, no regeneration).

### `plannen-photos.md` — photo organisation

- **Triggers on:** "find photos", "organise photos", "scan photos", "add photos for [event]".
- **Migrated content:** the picker-session workflow — resolve event → `create_photo_picker_session` → surface picker URI → wait for user signal → `poll_photo_picker_session` → report.

### `plannen-discovery.md` — search across sources + web

- **Triggers on:** "find me a [activity]", "any [event type] for [audience]", discovery-style questions.
- **Migrated content:** pick 2–4 tags → `search_sources` → fetch matching `source_url`s → web search → combine and present, noting source provenance.

### `plannen-watches.md` — watch processing

- **Triggers on:** "check my watched events" (manual). Also invokable from a future Claude routine for autonomous time-triggered monitoring.
- **Migrated content:** the full processing flow — fetch enrollment URL → web search → extract → compute hash → compare → `update_event` + `update_watch_task`. Plus `next_check` calculation rules and recurring-event handling.

### `plannen-sources.md` — manual source analysis

- **Triggers on:** "analyse my sources" (the manual variant of the auto-trigger that lives in core).
- **Migrated content:** call `get_unanalysed_sources` → fetch each `source_url` → call `update_source` with name, tags (specific activities, not generic "sports"), and `source_type`.

### Caveat: "always-on" reliability

Claude Code skills load on description match, not unconditionally. To make `plannen-core` reliably load, its description must match a wide range of plannen-related intents. We expect this to work in practice (by the time the agent is about to call any plannen tool, it should have picked up the skill), but if real-world testing shows the core skill misses early-session interactions, fallback is to ship a small project-level `CLAUDE.md` template via bootstrap that contains the core rules. This fallback is **held in reserve, not in V1**.

## Slash command inventory

Seven commands in V1. Each is a thin wrapper that triggers the matching skill — slash commands exist for discoverability (typing `/plannen-` shows the available verbs), not because the natural-language path is broken.

| Command | Args | Triggers | Notes |
|---|---|---|---|
| `/plannen-setup` | — | First-time config wizard | Detects Claude email → git email → prompt; writes `.env`; verifies Supabase reachable. Re-runnable. |
| `/plannen-doctor` | — | Diagnostic battery | Checks: `.env` present, Supabase up, MCP can authenticate, plannen user exists, optional Anthropic/Google keys present. |
| `/plannen-write-story` | `[event or date-range]` | `plannen-stories` skill | |
| `/plannen-organise-photos` | `[event]` | `plannen-photos` skill | |
| `/plannen-discover` | `<query>` | `plannen-discovery` skill | |
| `/plannen-check-watches` | — | `plannen-watches` skill | Manual trigger; will be supplemented (not replaced) by cloud routine. |
| `/plannen-backup` | — | Shell-runs `scripts/export-seed.sh` | Wraps an exec, not a skill. |

Each command is a markdown file at `plugin/commands/<name>.md` with YAML frontmatter (`description`, optional `argument-hint`) and a body containing the prompt template. Args expand via `$ARGUMENTS`.

### Setup/doctor sharing logic with bootstrap

`/plannen-setup` and `bootstrap.sh` write to and read from the same `.env`. The shared logic must live in a single helper module (proposed: `mcp/src/lib/config.ts`) consumed by both surfaces, to prevent drift.

## Configuration & first-run

### `.env.example`

```bash
# Plannen configuration
# Written by scripts/bootstrap.sh or /plannen-setup. Safe to edit by hand.

# Required — which plannen user this MCP operates as
PLANNEN_USER_EMAIL=

# Required — Supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # public demo key for local Supabase; replace if pointing at a cloud project

# Optional — AI features (BYOK; degrades gracefully if absent)
ANTHROPIC_API_KEY=

# Optional — Google Photos picker (disables that workflow if absent)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### `scripts/bootstrap.sh` flow

1. Pre-flight checks: docker, supabase CLI, node ≥ 20, pnpm. Print install hints if missing.
2. `pnpm install` (workspace install, includes `mcp/`).
3. `supabase start` (idempotent).
4. `supabase migration up`.
5. Detect default email cascade: Claude Code logged-in email → `git config user.email` → interactive prompt. Exact mechanism for Claude email detection is to be verified during implementation.
6. Confirm with user: "Use `<email>` as your Plannen user? [Y/n/edit]".
7. Auth bootstrap: check `auth.users` for matching email; if absent, create via Supabase admin API and insert a `user_profiles` row.
8. Build MCP: `pnpm --filter mcp build`.
9. Write `.env` from `.env.example` with the answers filled in.
10. Prompt: "Install Claude Code plugin now? [Y/n]" → `claude plugin install ./plugin` if yes.
11. Print: "Done. Run `pnpm dev` for the web app, or open Claude Code in this directory."

Step 7 is new logic. Today's `seed.sql` provides the auth user for the project owner; OSS users need their own auth user created on-the-fly.

### `/plannen-setup` flow

Same logic as bootstrap steps 5–9. Skips docker/supabase/build checks because Claude Code is already running, which means setup mostly happened. Used for: changing user email, adding an Anthropic key after the fact, switching `SUPABASE_URL` from local to cloud.

### `/plannen-doctor` checks

Diagnostic battery, prints pass/fail per item:

```
✓ .env present at /path/to/plannen/.env
✓ SUPABASE_URL reachable (http://127.0.0.1:54321)
✓ Migrations applied (20 files matched)
✓ Plannen user exists for pari@example.com
✓ MCP build present at mcp/dist/index.js
✗ ANTHROPIC_API_KEY not set — AI features disabled
✗ GOOGLE_CLIENT_ID not set — photo picker disabled
```

### Failure modes

| Condition | MCP/skill behaviour | User remediation |
|---|---|---|
| User opens Claude Code without bootstrap | First MCP call returns: `Plannen not configured. Run /plannen-setup or scripts/bootstrap.sh.` `plannen-core` skill catches and explains. | Run setup. |
| `PLANNEN_USER_EMAIL` doesn't match a DB user | MCP errors at `uid()` resolution: `No plannen user found for <email>. Run /plannen-setup.` | Re-run setup with correct email. |
| Supabase not running | First query fails: `Cannot reach Supabase at <url>. Is supabase start running?` | `supabase start`. |
| Optional keys missing | Specific tools error with hint; other tools work. | `/plannen-setup` to add. |

## CLAUDE.md transition

After the plugin is shipped, `CLAUDE.md` shrinks to roughly 30 lines of developer-facing notes (architecture pointer, build commands, plugin install pointer, DB safety summary). All workflow content migrates to plugin skills.

Mapping summary:

| Current `CLAUDE.md` section | Destination |
|---|---|
| Database migrations | `plannen-core` skill |
| Watch monitoring | `plannen-watches` skill (+ future routine) |
| Source analysis (auto-trigger) | `plannen-core` skill |
| Source analysis (manual "analyse my sources") | Deferred to V1.1 (`/plannen-analyse-sources`) |
| Profile building | `plannen-core` skill |
| Event creation intent gate | `plannen-core` skill |
| Discovery queries | `plannen-discovery` skill |
| Stories | `plannen-stories` skill |
| Photo organisation | `plannen-photos` skill |

The cutover is a single PR that adds `plugin/skills/*.md`, replaces `CLAUDE.md` with the short developer-facing version, and adds the plugin manifest. Until that PR lands, plugin and `CLAUDE.md` can coexist (harmless overlap — Claude reads both).

## Backlog (explicit deferrals)

Recorded so they aren't lost.

### Near-term (V1.1)

1. **Cloud routine for watch monitoring.** Watch processing logic lives in `plannen-watches`; the routine layer (a `/schedule` invocation or a `routines/plannen-watch.json` template) wakes daily, calls `get_watch_queue`, and processes each item. Removes the need for the user to be in a Claude session for watches to fire. Blocked on `plannen-watches` skill being shipped first.
2. **BYOK design.** Separate brainstorm. Plugin already accommodates the slot; the abstraction (edge-function per-request keys, web-app key UI, plugin "no key" signal) needs design.

### V1.1 catalogue

3. **`/plannen-analyse-sources`** — bulk manual source analysis. Auto-trigger from `plannen-core` covers the common case.
4. **`/plannen-status`** — config inspector. `/plannen-doctor` covers the practical case.

### Future (Tier 4 / multi-environment)

5. **Tier 4 (hosted) compatibility.** Plugin currently assumes localhost Supabase + service-role key. Hosted requires a different MCP launch mode and revisited auth. Touches BYOK.
6. **Multi-user MCP.** DB schema supports it; MCP is hardcoded to one `PLANNEN_USER_EMAIL`. Tier 4 concern.

### Future (packaging)

7. **Plugin marketplace publication.** V1 is local-path install. Marketplace requires either standalone plugin (no `../mcp/dist/index.js` reference) or a meta-package handling clone-and-install.
8. **Plannen CLI as a published binary.** The shared config helper (`mcp/src/lib/config.ts`) could grow into `npx plannen-cli setup`, useful for routines and non-Claude users.
9. **Cross-CLI support: Codex, Cursor, Gemini CLI, MiniMax CLI.** The MCP server already works in any MCP-capable host (Claude Desktop / Claude Code / Codex / Cursor / Gemini CLI all speak MCP), so tooling parity is mostly free. What's not free: each CLI has its own format for skills, slash commands, and agents. The CLAUDE.md → `plannen-*.md` skill migration is Claude-Code-specific; equivalent surfaces would need writing for each ecosystem (Cursor rules, Codex agent definitions, Gemini CLI's equivalent). Goal is "Plannen workflows are usable from any major coding-agent CLI." V1 ships Claude Code only; other CLIs added based on demand. The web UI is the cross-CLI fallback — same workflows, no CLI required.

### Quality-of-life flags

9. **`plannen-core` always-on reliability.** If skill description matching proves unreliable for early-session interactions, fallback is a project-level `CLAUDE.md` template that bootstrap copies in. Hold in reserve.
10. **`.gitignore` hardening — done.** `supabase/seed.sql` and `supabase/seed-photos.tar.gz` are added to `.gitignore` in the OSS-blockers PR.

## Risks & open questions

- **Claude Code email detection mechanism is unverified.** Section 5 states the cascade (Claude email → git email → prompt) but the exact API for retrieving the Claude login email needs verification during implementation. If unavailable, `git config user.email` becomes the primary default.
- **Auth user creation in bootstrap is new logic.** No existing code path creates an auth user from the bootstrap context. Implementation needs to use the Supabase admin API with the service-role key.
- **`plannen-core` skill activation timing.** As flagged, skills load on description match. The core skill must be written so Claude reliably picks it up before the first relevant action. This will need empirical testing post-implementation.
- **Plugin installation discoverability for non-Claude-Code users.** If a user only wants the web app + MCP via Claude Desktop, they shouldn't need to install the plugin. The `.mcp.json.example` template covers this path, but it must be documented in the root README.

## Cross-references

- `docs/TIERED_DEPLOYMENT_MODEL.md` — Plannen's tiered deployment model. This plugin design corresponds to the Tier 1 (Fully Local) Claude Code surface.
- Memory: `project_pending_features.md`, `project_deployment_model.md`.
- Future spec: `2026-MM-DD-byok-design.md` (next brainstorm).
- Future spec: `2026-MM-DD-oss-blockers-design.md` (after BYOK).
- Future spec: `2026-MM-DD-bootstrap-and-setup-story-design.md` (after blockers).
