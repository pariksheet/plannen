# Plannen Bootstrap & Setup Story — Design

**Date:** 2026-05-09
**Status:** Design approved; pending implementation plan
**Branch:** feat/tier-1-opensource
**Related:** `2026-05-09-plannen-plugin-architecture-design.md`, `2026-05-09-byok-design.md`, `2026-05-09-oss-blockers-design.md`

## Context

The plugin and BYOK specs assume a working Plannen install: local Supabase running, migrations applied, an `auth.users` row matching `PLANNEN_USER_EMAIL`, the MCP built, the plugin installable. None of that materializes by itself when an OSS user clones the repo.

Today the path is: read 338 lines of README, run a sequence of commands that span multiple terminals, edit `.env` files by hand, run a now-obsolete `scripts/install-plannen-command.sh` that registers the legacy `/plannen` command and wires `claude mcp add` for one user. With the plugin shipping, the install path is clean enough that a single bootstrap script can collapse all of it into one command.

This spec defines that script and the relationship between it and the in-Claude-Code re-config surfaces (`/plannen-setup`, `/plannen-doctor`).

## Goals & non-goals

### Goals

- After `git clone` plus `bash scripts/bootstrap.sh`, an OSS user with Docker (or any OCI runtime), Node, and the supabase CLI installed lands at "Plannen is configured for me; the web app and Claude Code can both reach it" in one terminal session.
- Idempotent: re-running with the same `.env` is a no-op for everything that's already done.
- Single source of identity: the email the user provides drives the auth user, the MCP `PLANNEN_USER_EMAIL`, and (later) Google OAuth tied to that user.
- `supabase functions serve` runs in the background after bootstrap exits, so web AI features work the moment bootstrap finishes — without the user having to open a second terminal.
- Bootstrap remains the canonical "fix-all" recovery path. `/plannen-doctor` recommends targeted single-command fixes for individual failures and only suggests re-running bootstrap when 2+ hard checks fail.

### Non-goals (V1)

- Hosted Supabase support. Bootstrap targets local Supabase only. Tier 4 is a separate spec.
- Multi-user. Bootstrap creates one auth user.
- JSON-editing Claude Desktop's config. Bootstrap detects Claude Desktop and prints the snippet plus the target path; the user pastes.
- Reading Claude Code's logged-in email. The cascade is `git config user.email` → interactive prompt. No `claude` CLI introspection.
- Windows native. Use WSL2 (bash-based; bootstrap will not be ported to PowerShell).
- Auto-management of `npm run dev`. Vite is the user's foreground concern.
- A `--force` flag that wipes the DB on the different-email abort. The hinted manual `supabase db reset` workflow is enough.

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Entrypoint shape | Pure bash script (`scripts/bootstrap.sh`). | Node script (`bootstrap.mjs`); bash thin wrapper + TS helper; skip bootstrap, lean on README + `/plannen-setup`. |
| Auth user creation | Auto-create via supabase admin API (`auth.admin.createUser({ email, email_confirm: true })`). | Manual signup-first; hybrid with fallback; skip — leave to user. |
| Container runtime check | Generic `docker info` against any running daemon. | Detect Docker Desktop / Colima / OrbStack and tailor the hint per runtime. |
| Functions serve lifecycle | Background process with PID file plus `functions-start.sh` / `functions-stop.sh`. | Print the command and have the user run it; fold into `local-start.sh`. |
| Plugin install | If `claude` CLI present, prompt `Y/n` then run `claude plugin install ./plugin`. | Always silent; never auto-run, only print. |
| `/plannen-setup` scope | Re-config only — edits `.env` values (email, Supabase URL/keys, Google OAuth). | Full re-bootstrap inside Claude Code; thin wrapper that runs bootstrap.sh via the Bash tool. |
| Legacy artefacts | Delete `scripts/install-plannen-command.sh` and `.claude/commands/plannen.md`. Add an uninstall hint to the plugin README. | Keep as a deprecation stub that errors with redirect; keep both for back-compat. |
| Auth-user creation mechanism | Tiny Node helper at `scripts/lib/auth-user.mjs` that re-uses `mcp/node_modules`. | Bash + `curl` against the admin REST endpoint directly. |
| Non-interactive use | `--non-interactive` flag (V1). When set, all values must come from existing `.env` or env vars; never prompts; exits non-zero on missing required values. | Prompt-only V1, defer flag. |

## Bootstrap step-by-step

```
 1. Pre-flight
 2. Email cascade
 3. Dependencies
 4. Local Supabase
 5. Migrations
 6. Auth user
 7. Write .env
 8. Functions serve (background)
 9. Plugin install (Claude Code)
10. Claude Desktop hint
11. Final printout
```

### 1. Pre-flight

- `docker` CLI present? If not: print install hints covering Docker Desktop, Colima, OrbStack, Rancher Desktop (macOS); Docker Engine, podman with docker-compat (Linux/WSL2).
- `docker info` exits 0 against a running daemon? If not: print start hints —
  - Docker Desktop / OrbStack / Rancher Desktop: open the app
  - Colima: `colima start`
  - podman: `podman machine start`
- Then check: `node` ≥ 20 LTS, `supabase` CLI ≥ 2.0, `bash` ≥ 3.2 (macOS reality — keep all bash compatible with 3.2; no associative arrays, no `mapfile`).
- `claude` CLI: optional; only gates step 9.

Each failed check prints both the install command (Homebrew or curl one-liner) and a short "why this is needed" line.

### 2. Email cascade

- If `.env` already has `PLANNEN_USER_EMAIL`, use it without prompting (idempotent re-run).
- Otherwise: default = `git config user.email`. If unset, prompt.
- Always confirm: `Use <email> as your Plannen user? [Y/n/edit]`.

In `--non-interactive` mode: skip the prompt; require `PLANNEN_USER_EMAIL` either already in `.env` or passed as `--email <addr>` (or env var). Exit non-zero if missing.

### 3. Dependencies

```
npm install                             # root, Vite app + test tooling
cd mcp && npm install && npm run build  # MCP, including the new dotenv dep
```

Both are idempotent (`npm install` is a no-op when `package-lock.json` matches `node_modules`; `npm run build` is `tsc` and is idempotent against unchanged source).

### 4. Local Supabase

Delegate to `bash scripts/local-start.sh`. That script already handles `supabase start` plus the Kong magic-link route patch. Both halves are idempotent — supabase CLI no-ops if already running; Kong patch is overwrite-replace.

### 5. Migrations

```
supabase migration up
```

Tracks applied migrations on its own — re-runs are no-ops. If a migration fails, abort with the supabase error and exit; the user fixes the migration and re-runs bootstrap.

### 6. Auth user

Invoke `node scripts/lib/auth-user.mjs <email>`. The helper:

1. Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from environment (bootstrap exports them inline before invoking).
2. Lists `auth.users` and matches by lowercased email.
3. If found: prints the UUID and exits 0.
4. If not found AND no other users exist: calls `auth.admin.createUser({ email, email_confirm: true })`; prints the new UUID; exits 0. The `on_auth_user_created` trigger creates the corresponding `public.users` row automatically.
5. If not found BUT another user already exists: exits non-zero with the abort message:
   ```
   There is already a Plannen user with email <existing>.
   Single-user-per-instance is V1's design.

   Options:
     1. Edit .env to use <existing>, then re-run bootstrap.
     2. Wipe the local DB and start over:
          bash scripts/export-seed.sh   # backup first
          supabase db reset
          bash scripts/bootstrap.sh
   ```

The helper invokes the admin API via `@supabase/supabase-js`, which already exists in the root `node_modules` (it's a root dependency for the Vite app's Supabase client). Bootstrap runs the helper from the repo root so node's module resolver picks it up directly — no `cd mcp/`, no `NODE_PATH` tricks. Order matters: step 3 (which runs `npm install` at the root) must complete before step 6.

### 7. Write `.env`

Render the root `.env` from `.env.example`, substituting `PLANNEN_USER_EMAIL`. If `.env` already exists, merge: keep all existing values, add anything `.env.example` introduces that's missing. This preserves user-modifications between re-runs (especially `GOOGLE_CLIENT_*` if they were added via `/plannen-setup`).

Also create `supabase/functions/.env` from `supabase/functions/.env.example` if missing. Bootstrap does not populate Google OAuth values — that's `/plannen-setup` territory. Functions will load with empty Google values and degrade gracefully (Google-dependent functions error with a clear message; AI functions work fine).

`ANTHROPIC_API_KEY` is intentionally not written to `.env`. BYOK lives in the `user_settings` DB table; the user adds the key via the web app's `/settings` page after bootstrap completes.

### 8. Functions serve (background)

Start `supabase functions serve --env-file supabase/functions/.env` via:

```bash
mkdir -p .plannen
nohup supabase functions serve --env-file supabase/functions/.env \
  > .plannen/functions.log 2>&1 &
echo $! > .plannen/functions.pid
```

Idempotency: before starting, read `.plannen/functions.pid`. If the PID exists and the process is alive (`kill -0 $PID 2>/dev/null`), skip. If the file exists but the process is dead, remove the file and start fresh.

Two new lifecycle scripts:

- `scripts/functions-start.sh` — re-launches if dead. Same idempotency check as bootstrap step 8. Used standalone for "I rebooted; just bring functions back up" without re-running the full bootstrap.
- `scripts/functions-stop.sh` — kills the PID, removes the file. Safe to call when nothing is running.

`.plannen/` is gitignored. Logs accumulate there; users can `tail -f .plannen/functions.log` to debug.

### 9. Plugin install (Claude Code)

If `claude` CLI is on PATH:

```
Install Claude Code plugin now? [Y/n]
```

On Y: `claude plugin install ./plugin`. The plugin's MCP entry uses `${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js` and self-loads `<repo-root>/.env` via the dotenv shim that lives in `mcp/src/index.ts`.

If `claude` is absent, print:

```
Claude Code not detected. To install the plugin later:
  1. Install Claude Code: https://claude.com/claude-code
  2. From this repo's root: claude plugin install ./plugin
```

In `--non-interactive`: skip the prompt; install only if `--install-plugin` is passed.

### 10. Claude Desktop hint

Detect Claude Desktop:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` parent dir, or `/Applications/Claude.app`.
- Linux: `~/.config/Claude/claude_desktop_config.json` parent.
- Windows (WSL2 only — V1 doesn't target native Windows): skip.

If detected, print:

```
Detected Claude Desktop. To use Plannen there too, add this MCP server
to claude_desktop_config.json (at <path>):

  {
    "mcpServers": {
      "plannen": {
        "command": "node",
        "args": ["<absolute path to mcp/dist/index.js>"],
        "env": {
          "SUPABASE_URL": "http://127.0.0.1:54321",
          "SUPABASE_SERVICE_ROLE_KEY": "<copy from .env>",
          "PLANNEN_USER_EMAIL": "<the email above>"
        }
      }
    }
  }

Restart Claude Desktop after editing.
```

Bootstrap does not modify the file — JSON-merge in bash is a foot-gun, and silently editing a config file the user owns crosses a trust boundary. Print only.

### 11. Final printout

```
✓ Plannen is configured for <email>.

Next steps:
  → Web app:    npm run dev   →  http://localhost:5173
  → Sign in:    enter <email>, click "Magic link"
                Link arrives at http://127.0.0.1:54324 (Mailpit)
  → AI key:     web app → /settings → paste your Anthropic key
  → Functions:  running in background (PID <n>)
                Logs: .plannen/functions.log
                Stop: bash scripts/functions-stop.sh
```

## `/plannen-setup` — re-config

Re-config only, in-Claude-Code surface. Always reads existing `.env` first; treats values as defaults.

### Editable surface

| Field | Behavior |
|---|---|
| `PLANNEN_USER_EMAIL` | Switch identity. Same auth-user logic as bootstrap step 6 — check existing `auth.users` row; if a different user already exists, refuse with the same hint. After save: prompt the user to restart Claude Code or use `/mcp` to reconnect plannen. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | For users pointing at hosted Supabase. Only prompt if user wants to change. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Most common reason to re-run setup — adding Google Photos OAuth after first install. Updates both root `.env` and `supabase/functions/.env`. |

### What it does NOT do

- Install npm deps, build MCP, run migrations.
- Manage `functions-serve` lifecycle.
- Install the plugin.
- Touch the AI key (that's `/settings` in the web app).

After writing `.env`, `/plannen-setup` runs `/plannen-doctor` and reports the result.

## `/plannen-doctor` — tiered recovery

Each failure surfaces a single targeted fix command. Bootstrap is suggested only when the failure pattern is broad enough to warrant a re-run.

```
✓ .env present at /path/to/plannen/.env
✓ PLANNEN_USER_EMAIL=you@example.com
✓ Supabase reachable (http://127.0.0.1:54321)
✗ Plannen user does not exist for you@example.com
   → Sign up at http://localhost:5173 (magic link arrives at http://127.0.0.1:54324)
✗ MCP build missing at mcp/dist/index.js
   → cd mcp && npm install && npm run build
✓ Plugin installed in Claude Code
✗ Functions-serve not running
   → bash scripts/functions-start.sh
⚠ Anthropic key not configured
   → web app → /settings
⚠ GOOGLE_CLIENT_ID not set — photo picker disabled
   → /plannen-setup

Summary: 4 ok, 3 hard failures, 2 warnings.
3 hard failures detected. If targeted fixes don't resolve them, re-run
`bash scripts/bootstrap.sh` — it's idempotent and re-establishes any
missing pieces.
```

The "re-run bootstrap" tail-line appears only when ≥ 2 hard checks fail. Single failures get only the targeted fix.

## Files added, modified, deleted

### Added

- `scripts/bootstrap.sh` (~150 lines, pure bash, sources `scripts/lib/bootstrap-helpers.sh`).
- `scripts/functions-start.sh` (~30 lines).
- `scripts/functions-stop.sh` (~15 lines).
- `scripts/lib/bootstrap-helpers.sh` — small helpers: `prereq_ok()`, `confirm_email()`, `merge_env()`, `pid_alive()`. Sourced by both `bootstrap.sh` and `functions-start.sh`.
- `scripts/lib/auth-user.mjs` — Node helper for step 6 (~30 lines). Uses `@supabase/supabase-js` from the root `node_modules` (already a root dependency).
- `.plannen/` directory (gitignored) — holds `functions.pid` and `functions.log`.

### Modified

- `.gitignore` — add `.plannen/`.
- `README.md` — replace the multi-step "Setup" section with a single `bash scripts/bootstrap.sh` line. Keep the daily-workflow section but reference the new scripts. Remove all references to `install-plannen-command.sh` and `/plannen` (the legacy slash command).
- `plugin/commands/plannen-setup.md` — refine to match the "edit `.env` only" scope, including the auth-user-switch handling.
- `plugin/commands/plannen-doctor.md` — implement the tiered-hint logic and the "re-run bootstrap if 2+ fail" tail line.
- `plugin/README.md` — add the uninstall hint for users who previously ran the legacy installer:
  > **If you previously ran `scripts/install-plannen-command.sh`**: remove the stale `~/.claude/commands/plannen.md` file and run `claude mcp remove plannen -s user` before installing the plugin.

### Deleted

- `scripts/install-plannen-command.sh` — fully obsoleted by the plugin.
- `.claude/commands/plannen.md` — legacy slash command; replaced by `plugin/commands/plannen-*.md`.

## Failure modes & idempotency

### Re-run with same `.env`

Every step is a no-op:
- `npm install`: skips when `package-lock.json` matches.
- `supabase start`: idempotent.
- `migration up`: skips applied migrations.
- Auth user: detects existing row by email, skips create.
- Functions-serve: detects live PID, skips.
- Plugin install: prompts; user says no, exit clean.

### Re-run with different email

`auth-user.mjs` exits non-zero with the abort message in §6. Bootstrap halts. User edits `.env` to the existing email or wipes the DB per the hint.

### Bootstrap interrupted mid-run

Each step is independently idempotent — re-run picks up. The functions-serve step is the only one whose side-effect survives a parent crash; the PID-file check makes restart safe.

### Step-specific failures

| Step | Failure | Bootstrap behaviour |
|---|---|---|
| 4 | `supabase start` fails (Docker not actually up despite step 1 saying so) | Abort with the supabase error; user fixes Docker, re-runs. |
| 5 | Migration syntax / data error | Abort with supabase output; user fixes the migration, re-runs. Already-applied migrations are tracked. |
| 6 | Admin API unreachable | Abort: "Couldn't reach Supabase admin API. Check `supabase status` — re-run bootstrap when healthy." No partial `.env` written. |
| 6 | Different existing user | Abort with the hint above. |
| 8 | Functions serve fails to bind port | Print warning, finish bootstrap anyway. `/plannen-doctor` will catch it; user runs `scripts/functions-start.sh` after resolving. |
| 9 | `claude plugin install` fails | Print error and the manual `/plugin install ./plugin` fallback. Don't abort — bootstrap is still useful without the plugin. |

## Risks & open questions

- **NVM users + Claude Code as GUI.** Plugin manifest uses bare `node` in `command`. Claude Code launched as a macOS GUI app sometimes doesn't inherit shell PATH, so `node` isn't found and the MCP fails to start. The deleted `install-plannen-command.sh` worked around this with `which node` resolved to an absolute path. Mitigation: document in the plugin README ("if you use NVM, ensure node is also at `/usr/local/bin/node` or set `PATH` in your Claude Code launch env"). If real users hit this, V1.1 backlog candidate is generating a per-machine `plugin/.claude-plugin/plugin.local.json` with the absolute path.
- **Colima Docker-socket path.** Some Colima setups don't expose the docker socket where the supabase CLI looks. If `supabase start` fails on Colima, `colima start --network-address` plus `colima ssh -- sudo systemctl restart docker` usually fixes it. README troubleshooting note, not bootstrap concern.
- **`claude plugin install` CLI stability.** If Anthropic renames or moves it, bootstrap step 9 breaks. Documented manual fallback (`/plugin install ./plugin` from inside Claude Code) so users have an escape hatch.
- **Two env files.** Root `.env` (Vite + MCP) and `supabase/functions/.env` (edge functions). The duplication of `GOOGLE_CLIENT_ID` between them is pre-existing. V1.1+ idea: unify under root `.env` and have `functions serve` read from there. Not bootstrap-blocker.
- **Host architecture mismatch.** Apple Silicon vs. Intel — supabase CLI handles both, no special handling expected. Flag if real-user reports surface platform-specific issues.

## Backlog (explicit deferrals)

### Near-term (V1.1)

1. **Per-machine plugin local manifest** with absolute `node` path. If NVM-related MCP startup failures become common.
2. **Unified single `.env`** consumed by Vite, MCP, and edge functions. Removes the `supabase/functions/.env` redundancy.
3. **`scripts/dev.sh`** — convenience wrapper that runs `local-start.sh`, `functions-start.sh`, and `npm run dev` in one terminal pair.
4. **Hosted Supabase support** in bootstrap — `--supabase-url` and `--service-role-key` flags. Tier 4 territory.

### Medium-term

5. **Plugin marketplace publication** of `plannen` so the plugin install line becomes `claude plugin install plannen` (no path). Out of bootstrap scope; tracked in plugin spec backlog.
6. **Cross-CLI parity.** Codex, Cursor, Gemini CLI, MiniMax — bootstrap could optionally generate the equivalent agent definition or rules file for whichever CLI is detected. Tracked in plugin spec backlog item #9.

### Quality of life

7. **`scripts/functions-status.sh`** — quick alive-check + last log lines. Could be folded into `/plannen-doctor`.
8. **Self-update path** — `bash scripts/bootstrap.sh --update` that runs `git pull`, re-runs `npm install` and `supabase migration up`, restarts functions-serve. Useful once the project moves past V1 and migrations land regularly.

## Cross-references

- `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` — plugin architecture (bootstrap step 9 installs the plugin defined here).
- `docs/superpowers/specs/2026-05-09-byok-design.md` — BYOK (bootstrap deliberately does not write `ANTHROPIC_API_KEY`; users set it via `/settings`).
- `docs/superpowers/specs/2026-05-09-oss-blockers-design.md` — OSS blockers (bootstrap completes the OSS install story this spec opens).
- `docs/TIERED_DEPLOYMENT_MODEL.md` — Tier 1 (fully local) is bootstrap's exclusive target.
