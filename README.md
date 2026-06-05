<p align="center">
  <img src="public/logo.svg" alt="Plannen" width="320">
</p>

<p align="center"><em>Local-first AI planner that learns your preferences and turns events into memories.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/pariksheet/plannen/actions/workflows/ci.yml"><img src="https://github.com/pariksheet/plannen/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <img src="docs/images/screenshot-app.png" alt="Plannen calendar view" width="720">
</p>

<p align="center"><sub>… or skip the web app and just talk to Claude.</sub></p>

<p align="center">
  <img src="docs/images/screenshot-claude.png" alt="Asking Claude Code to find a sailing course for kids" width="720">
</p>

Plannen is a local-first AI planner. It knows your preferences and past events, helps you schedule what's next, and turns memorable moments into stories. Use it through the web app, or just talk to it from Claude Code or Claude Desktop — both surfaces drive the same database via an MCP server.

---

## Why it works

Two pieces do the heavy lifting:

**An MCP server.** Plannen ships an [MCP server](mcp/) that exposes its data layer — events, profile facts, family members, locations, sources, stories — as tools Claude Code and Claude Desktop can call directly. You don't talk to a bespoke chatbot; you talk to Claude in whatever client you already use, and Claude reaches into Plannen via MCP. The web app uses the same service functions, so the two surfaces stay in lockstep.

**A profile that learns.** Every time you mention something durable about yourself or your family in natural conversation — *"my son just turned 6"*, *"we prefer apartments over hotels"*, *"no highway charging when the kids are in the car"* — Plannen passively extracts the fact and saves it. The next time Claude plans something, it knows. Suggestions become personal: *"his school finishes Wednesday at 12:00, want a sports option that runs 13:00–15:00?"* rather than generic *"here are some sports classes in Belgium"*.

---

## Deployment modes

Pick one at `init` time; switch later by re-running `init`.

| Mode | What it is | When to use |
|------|------------|-------------|
| `local_pg` | Embedded Postgres + Plannen's own Hono backend. Node-only, no Docker. | Default. Fastest path; everything on your machine. |
| `local_sb` | Local Supabase stack (Postgres + Auth + Storage + Edge Functions) via Docker. | You want the full Supabase surface locally. |
| `cloud_sb` | Supabase Cloud project (DB + Storage + Edge Functions + remote MCP). | You want browser access from anywhere, or to deploy to Vercel. |

## Prerequisites

| Need | For | Install |
|------|-----|---------|
| [Node.js](https://nodejs.org/) ≥ 20 LTS | All modes | `brew install node` |
| [Claude Code](https://claude.com/claude-code) or [Claude Desktop](https://claude.ai/download) | The AI interface | claude.com/claude-code |
| A container runtime (Docker, [Colima](https://github.com/abiosoft/colima), [OrbStack](https://orbstack.dev)) | `local_sb` only | per-tool docs |
| [Supabase CLI](https://supabase.com/docs/guides/cli) ≥ 2.0 | `local_sb`, `cloud_sb` | `brew install supabase/tap/supabase` |
| A [Supabase Cloud](https://supabase.com/dashboard) project + `supabase login` | `cloud_sb` only | dashboard → new project |

---

## Quick start

```bash
git clone <repo-url> plannen
cd plannen
npm install
npx plannen init --mode=local_pg --email you@example.com
npx plannen up
```

Open <http://localhost:4321>. For the other modes, swap `--mode=local_sb` or `--mode=cloud_sb` (the cloud variant is interactive — it picks your project and asks for the DB password).

`init` is idempotent. Re-run any time. If something gets broken, `/plannen-doctor` (inside Claude Code) will diagnose and suggest a fix.

CI flags: `npx plannen init --help`.

## Daily workflow

```bash
npx plannen up             # db + backend + web dev
npx plannen up --no-dev    # headless: db + backend only (MCP/Claude use case)
npx plannen status         # what's running for the active profile
npx plannen down           # graceful shutdown
```

All sub-steps are idempotent, so re-running on a live stack is a no-op.

For auto-start at login (macOS LaunchAgent) and per-mode troubleshooting, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Profiles

A profile is a named bundle of mode + env settings. `plannen init` creates one called `default` and points `<repo>/.env` at it via symlink. You only need extra profiles when you want to run a second environment (e.g. a `staging` cloud setup) alongside your daily one.

```bash
npx plannen profile list                              # show all profiles, mark active
npx plannen profile create staging --mode=cloud_sb    # second cloud profile
npx plannen profile use staging                       # swap the .env symlink
npx plannen up --profile=default                      # one-off, doesn't change active
npx plannen profile delete staging --yes              # irreversible
```

Profile state lives under `~/.plannen/profiles/<name>/`. The active pointer is `~/.plannen/active`, or override per-shell with `PLANNEN_PROFILE=<name>`.

---

## Deploying to Vercel (`cloud_sb`)

```bash
npm i -g vercel && vercel login
npx plannen deploy
```

(`vercel link` is run automatically by `plannen deploy` if `.vercel/` doesn't exist.)

Post-deploy checklist (custom SMTP, custom domain, Google OAuth callback) lives in [`docs/VERCEL.md`](docs/VERCEL.md).

---

## AI provider (web-app features only)

Open **/settings** and pick one:

- **Claude Code CLI (`local_pg` only).** If `claude` is in your PATH, the backend auto-detects it and routes AI calls through your subscription. No API key required.
- **Anthropic API key (BYOK).** Paste a key from [console.anthropic.com](https://console.anthropic.com). Stored locally, never leaves your machine. Works on all modes.

Skip this if you only drive Plannen via Claude Code or Claude Desktop — MCP slash commands work without anything in `/settings`.

---

## Slash commands (in Claude Code)

After the plugin is installed:

| Command | What it does |
|---|---|
| `/plannen-doctor` | Diagnose env, DB, MCP, plugin, AI key, Google keys. |
| `/plannen-setup` | Re-config `.env` (email, Supabase URL/keys, Google OAuth). |
| `/plannen-write-story <event>` | Compose a story from event memories and photos. |
| `/plannen-organise-photos <event>` | Drive the Google Photos picker for an event. |
| `/plannen-discover <query>` | Find events from saved sources + web search. |
| `/plannen-check-watches` | Force-process the watch queue now. |
| `/plannen-backup` | Run `scripts/export-seed.sh`. |

The plugin also bundles always-on workflow skills (event-creation intent gate, profile extraction, source analysis, etc.) — see [`plugin/skills/`](plugin/skills/).

For plugin scope (user vs project) and Claude Desktop registration, see [`docs/PLUGIN.md`](docs/PLUGIN.md).

### Connect Plannen to claude.ai (web, Desktop, mobile, Chrome)

Tier 2 installs can register the Plannen MCP as a claude.ai custom connector:

1. `npx plannen cloud oauth enable --profile prod` (provision runs this automatically for new installs)
2. claude.ai → Settings → Connectors → Add custom connector → paste the printed URL
3. Click Connect — log in with your Plannen account and approve

The connector then works across claude.ai web, Claude Desktop, mobile, and
Claude in Chrome. The Claude Code plugin is unaffected — it keeps its
`plnnn_` token from `plugin.json`.

## MCP server modes

- **stdio (default)** — `mcp/src/` Node process. Used by `local_pg` and `local_sb`.
- **HTTP (default on `cloud_sb`)** — `supabase/functions/mcp/` Deno Edge Function, personal-access-token auth.

Switch with `bash scripts/mcp-mode.sh stdio|http`. The HTTP MCP does not include `transcribe_memory` (needs local Whisper). Use stdio if you need audio transcription.

## MCP Personal Access Tokens

Each user has their own PAT — like a GitHub PAT, but for Plannen. PATs scope every MCP call to the issuing user; RLS handles the rest.

### Admin / dev (you have DB access)

```bash
npx plannen token create --label "MacBook"
```

Mints a `plnnn_…` token, writes it to your active profile's env, and rewires `plugin/.claude-plugin/plugin.json`. Reload the plannen plugin in Claude Code.

### Inviting another user (they don't have DB access)

1. Share your deployment's `SUPABASE_URL` + anon key.
2. They run `npx plannen profile create --mode cloud_sb` and sign in via magic link at the deployment's web URL.
3. /settings → "Personal access tokens" → Generate, save the plaintext.
4. `npx plannen token activate <PAT>` — wires their plugin.

### Verbs

| Verb | What it does |
|---|---|
| `plannen token create --label <name>` | Mint a new PAT, wire it into active profile + plugin.json |
| `plannen token list` | Show your tokens (no plaintext) |
| `plannen token revoke <id>` | Revoke a token |
| `plannen token activate <PAT>` | Wire a PAT from /settings into active profile + plugin.json |
| `plannen token rotate` | Revoke current PAT, mint a fresh one |

---

## Backups

```bash
bash scripts/export-seed.sh
```

Writes `supabase/seed.sql` + `supabase/seed-photos.tar.gz` (both gitignored). To restore: drop both into `supabase/`, run `npx plannen init` again, then `bash scripts/restore-photos.sh`.

**Never run `supabase db reset` on `local_sb`** — it wipes the database. Use `supabase migration up` instead.

---

## Optional integrations

Google Calendar / Photos / Drive setup (Cloud Console + OAuth callback per mode) is in [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

---

## Project layout

```
plannen/
├── src/                  # React app (Vite + TypeScript)
├── mcp/                  # MCP server (pg.Pool + withUserContext)
├── backend/              # Hono backend (used by local_pg)
├── plugin/               # Claude Code plugin (skills + commands)
├── cli/                  # `plannen` CLI (init, up, down, status, profile)
├── supabase/
│   ├── migrations/       # Main schema (source of truth)
│   ├── functions/        # Edge functions
│   └── seed*.{sql,tar.gz}  # Personal data backups (gitignored)
├── scripts/              # Lower-level helpers the CLI delegates to
└── docs/                 # Design docs and architecture notes
```

---

## Tips

These aren't Plannen-specific — general practice for anyone using Claude or running a local-first app with personal data.

**Don't share your Claude sessions for model training.** API keys are excluded by Anthropic's commercial policy. If you sign Claude Code into a claude.ai subscription instead, open [claude.ai/settings/privacy](https://claude.ai/settings/privacy) and turn **"Help improve Claude"** off.

**Cap your Anthropic spend.** [console.anthropic.com](https://console.anthropic.com) → Workspaces → create one → set a monthly spend limit → generate a key scoped to that workspace. If a key leaks, blast radius is bounded.

**Back up your data.** `bash scripts/export-seed.sh` writes the two seed files; copy them somewhere safe. Encrypt if you upload to a cloud provider.
