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

Plannen is a local-first AI planner. It knows your preferences and past events, helps you schedule what's next, and turns memorable moments into stories. Your data stays on your machine. Use it through the web app, or just talk to it from Claude Code or Claude Desktop — both surfaces drive the same local database via an MCP server.

---

## Why it works

Two pieces do the heavy lifting:

**An MCP server.** Plannen ships an [MCP server](mcp/) that exposes its data layer — events, profile facts, family members, locations, sources, stories — as tools Claude Code and Claude Desktop can call directly. You don't talk to a bespoke chatbot; you talk to Claude in whatever client you already use, and Claude reaches into your local Plannen database via MCP. Slash commands, the event-creation intent gate, discovery, source analysis, story generation, watch monitoring — all flow through this layer. The web app uses the same service functions, so the two surfaces stay in lockstep.

**A profile that learns.** Every time you mention something durable about yourself or your family in natural conversation — *"my son just turned 6"*, *"we prefer apartments over hotels"*, *"no highway charging when the kids are in the car"* — Plannen passively extracts the fact and saves it. The next time Claude plans something, it knows. Suggestions become personal: *"his school finishes Wednesday at 12:00, want a sports option that runs 13:00–15:00?"* rather than generic *"here are some sports classes in Belgium"*. The profile is also corrigible — you can ask Claude what it knows about you, fix anything wrong, and watch it stick.

Together these turn Plannen from a calendar into an assistant. The data stays on your machine; the intelligence travels with the AI client of your choice.

---

> **Tier 0 — Bundled (default).** Plannen runs on your computer with just Node 20+ — no Docker, no Supabase CLI. Postgres is an embedded binary started by Node; the MCP server talks to it directly. See [`docs/TIERED_DEPLOYMENT_MODEL.md`](docs/TIERED_DEPLOYMENT_MODEL.md) for the full tier model. Tier 1 (local Supabase + edge functions) stays available via `bash scripts/bootstrap.sh --tier 1` for users who want the full Docker stack.

---

## Prerequisites

### Tier 0 (default)

| Tool | Why | Install |
|------|-----|---------|
| [Node.js](https://nodejs.org/) ≥ 20 LTS | Runs the embedded Postgres, MCP server, web app | `brew install node` (or nvm/asdf/volta) |
| [Claude Code](https://claude.com/claude-code) (recommended) or [Claude Desktop](https://claude.ai/download) | The AI interface | claude.com/claude-code |

```bash
node --version  # expect v20+
```

### Tier 1 (opt-in — `--tier 1`)

Adds Docker + Supabase CLI to the above:

| Tool | Why | Install |
|------|-----|---------|
| A container runtime | Runs local Supabase (Postgres + Auth + Storage) | Docker Desktop, [Colima](https://github.com/abiosoft/colima), [OrbStack](https://orbstack.dev), Rancher Desktop |
| [Supabase CLI](https://supabase.com/docs/guides/cli) ≥ 2.0 | Manages local DB, migrations, seeds | `brew install supabase/tap/supabase` |

### Tier 2 (opt-in — `--tier 2`)

Cloud-resident DB + Storage + Edge Functions + remote MCP, against a Supabase Cloud project you own. Requires Supabase CLI (same as Tier 1) plus:

| Step | Why |
|------|-----|
| A Supabase Cloud project | The destination. Create one at [supabase.com/dashboard](https://supabase.com/dashboard); copy the project ref (~20-char slug from the URL) and the connection-pooler URL (Project Settings → Database → Connection string → URI). |
| `supabase login` | One-time CLI auth to your Supabase account. |
| Tier 1 first | Tier 2 migrates from Tier 1 (snapshot → cloud). Run `bash scripts/bootstrap.sh --tier 1` first if you're not already there. (Fresh Tier 2 installs without prior data also work; the migration steps just no-op.) |

See the [Tier 2 setup section below](#tier-2-cloud-opt-in) for the migration command.

---

## Setup — one command

```bash
git clone <repo-url> plannen
cd plannen
bash scripts/bootstrap.sh                # Tier 0, default
# bash scripts/bootstrap.sh --tier 1     # opt-in to the local Supabase stack
```

That's it. In Tier 0, `bootstrap.sh` does prereq checks, npm install, starts an embedded Postgres at port 54322, applies migrations (Tier 0 overlay + main schema), inserts your user row, writes `.env` with `PLANNEN_TIER=0` + `DATABASE_URL`, and offers to install the Claude Code plugin. In Tier 1 it instead runs `supabase start`, `supabase migration up`, the auth-user admin call, and `functions-serve`.

The script is idempotent — re-run it any time. If something gets broken, `/plannen-doctor` (inside Claude Code) will diagnose and suggest the targeted fix.

For automated/CI use:

```bash
bash scripts/bootstrap.sh --non-interactive --email you@example.com [--install-plugin]
```

### Tier 2 (cloud, opt-in)

If you already have a working Tier 1 install with data, migrate to your Supabase Cloud project in one command:

```bash
bash scripts/bootstrap.sh --tier 2 \
  --project-ref <your-project-ref> \
  --cloud-db-url 'postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres'
```

What this does:

1. Snapshots your local Tier 1 DB + photos.
2. `supabase link`s the repo to your cloud project and reads its API keys.
3. `supabase db push`es the schema.
4. Restores Tier 1 data into the cloud DB inside a single transaction. Aborts if the cloud DB already has data unless you pass `--force-overwrite`.
5. Uploads every object in your `event-photos` bucket to the cloud bucket via Storage REST. Resumable across runs via `.tier2-uploaded.txt`. Warns and stops at >1 GB unless you pass `--accept-storage-quota` (or skip with `--skip-photos`).
6. Deploys all edge functions (MCP first, then the rest). Sets `MCP_BEARER_TOKEN` (generated) and other secrets.
7. Rewrites local `.env` and `plugin/.claude-plugin/plugin.json` to point at the cloud project. Backs up the originals to `.env.tier1.bak` and `plugin.json.tier1.bak`.
8. Runs `scripts/cloud-doctor.mjs` to confirm everything's healthy.

After it finishes:
- Reload the plannen plugin in Claude Code so the new HTTP MCP endpoint takes effect.
- Add `https://<your-ref>.supabase.co/functions/v1/google-oauth-callback` to your Google Cloud OAuth client (if you use Google Calendar / Photos integration).
- `npm run dev` now talks to your cloud Supabase project.

Operating Tier 2:

```bash
bash scripts/mcp-rotate-bearer.sh    # rotate the MCP bearer (cloud secret + local files)
node scripts/cloud-doctor.mjs        # ad-hoc health check
bash scripts/bootstrap.sh --tier 1   # roll back to Tier 1 (cloud project left intact)
```

The Tier 2 design is in [`docs/superpowers/specs/2026-05-16-tier-2-cloud-deploy-design.md`](docs/superpowers/specs/2026-05-16-tier-2-cloud-deploy-design.md). Hosted web app (Vercel) is **Phase B.2** — a separate spec; today the web app still runs locally.

### After bootstrap

1. **Sign in to the web app.** `npm run dev`, then open [http://localhost:4321](http://localhost:4321). Enter the email you bootstrapped with and click *Magic link* — the link arrives at [Mailpit](http://127.0.0.1:54324) (no real email sent).

2. **Pick an AI provider (only if you'll use AI features in the web app).** Open **/settings** and choose one:

   - **Claude Code CLI (Tier 0 only).** If you already have a Claude subscription and the `claude` binary in your PATH (install: [claude.com/code](https://claude.com/code)), the backend auto-detects it on first boot and routes AI calls through your subscription. No API key required. Tested with Claude Code 1.x.
   - **Anthropic API key (BYOK).** Paste a key from [console.anthropic.com](https://console.anthropic.com). Stored in your local Plannen database, never leaves your machine. Works on both tiers.

   Powers web-app AI features — event discovery, story generation, image extraction. Skip if you only drive Plannen via Claude Code or Claude Desktop: the MCP slash commands (`/plannen-discover`, `/plannen-write-story`, …) work without anything in `/settings`.

3. **Use Claude.** If you accepted the plugin install at the end of bootstrap, you're done — Claude Code already has Plannen's tools and slash commands. Type `/plannen-doctor` to verify, then start chatting about events.

---

## Daily workflow

After a reboot, **one command brings the right stack up for your tier**:

```bash
bash scripts/start.sh            # everything Plannen needs (pg/supabase + backend + web dev)
bash scripts/start.sh --no-dev   # headless: pg + backend only (MCP/Claude use case)
bash scripts/stop.sh             # graceful umbrella shutdown
```

`start.sh` reads `PLANNEN_TIER` from `.env` and calls the right sub-scripts (`pg-start` + `backend-start` for Tier 0; `local-start` + `functions-start` for Tier 1). All sub-scripts are idempotent, so re-running on a live stack is a no-op.

### Auto-start at login (macOS)

Drop this LaunchAgent at `~/Library/LaunchAgents/com.plannen.start.plist`, then `launchctl load ~/Library/LaunchAgents/com.plannen.start.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.plannen.start</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/absolute/path/to/plannen/scripts/start.sh</string>
    <string>--no-dev</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/.plannen/start.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.plannen/start.log</string>
</dict>
</plist>
```

Drop `--no-dev` if you want the web dev server running on login too. (Tier 1 needs Docker to be running first; `OnDemand`/`KeepAlive` can be added if Docker startup is slow.)

### Lower-level (still works)

```bash
# Tier 0
bash scripts/pg-start.sh        # embedded Postgres on 54322
bash scripts/backend-start.sh   # Plannen backend on 54323
npm run dev                     # web app at http://localhost:4321

# Tier 1
bash scripts/local-start.sh     # start Supabase (Kong-patched)
bash scripts/functions-start.sh # start edge functions
npm run dev                     # web app at http://localhost:4321
```

Or just re-run `bash scripts/bootstrap.sh [--tier 1]` — it's idempotent and will auto-restore `supabase/seed.sql` if your DB is empty.

---

## MCP server modes

Plannen ships two MCP server implementations:

- **stdio (default)** — `mcp/src/` Node process, spawned by Claude Code as a subprocess. Used in Tier 0 and Tier 1 by default.
- **HTTP (opt-in on Tier 1, default on Tier 2)** — `supabase/functions/mcp/` Deno Edge Function. On Tier 1 it's served locally by `supabase functions serve mcp`; on Tier 2 it's `supabase functions deploy mcp`ed to the cloud project and reached at `https://<ref>.supabase.co/functions/v1/mcp` with a bearer token.

Switch between them with `bash scripts/mcp-mode.sh stdio` or `bash scripts/mcp-mode.sh http`. The HTTP mode generates and persists a bearer in `supabase/.env.local` on first use. After switching, reload the plannen plugin in Claude Code.

The HTTP MCP does not include `transcribe_memory` (it requires a local Whisper binary not available in Deno). Use stdio if you need audio transcription.

## Slash commands (in Claude Code)

After the plugin is installed:

| Command | What it does |
|---|---|
| `/plannen-doctor` | Diagnose Plannen — env, Supabase, MCP, plugin, functions-serve, AI key, Google keys. |
| `/plannen-setup` | Re-config `.env` (email, Supabase URL/keys, Google OAuth). Does NOT do first-time install — that's `bootstrap.sh`. |
| `/plannen-write-story <event>` | Compose a story from event memories and photos. |
| `/plannen-organise-photos <event>` | Drive the Google Photos picker for an event. |
| `/plannen-discover <query>` | Find events from saved sources + web search. |
| `/plannen-check-watches` | Force-process the watch queue now. |
| `/plannen-backup` | Run `scripts/export-seed.sh`. |

The plugin also bundles always-on workflow skills (event-creation intent gate, profile extraction, source analysis, etc.) — see `plugin/skills/` for details.

### Plugin scope: user vs project

By default, `bootstrap.sh` installs the plugin at **user scope** — it loads in every Claude Code session you start, anywhere on your machine. Verify with `claude plugin list` (look for `Scope: user`).

If you'd rather have Plannen load only when you're working inside this repo, reinstall at project scope:

```bash
claude plugin uninstall plannen
claude plugin marketplace remove plannen
claude plugin marketplace add ./ --scope project
claude plugin install plannen@plannen --scope project
```

Project-scope settings live in `.claude/settings.json` (committed to the repo, so the choice travels with the codebase). User-scope settings live in `~/.claude/settings.json` and reference the repo by absolute path — if you move or delete the repo, a user-scope install breaks.

Trade-offs:

- **User scope (default):** slash commands like `/plannen-doctor` are always available, even in unrelated projects. Convenient if you only have one Plannen checkout, but the MCP server runs in every session whether you need it or not.
- **Project scope:** plugin only activates inside this repo. Cleaner separation, no stale-path risk, but requires re-installing for each fresh clone.

### Using Plannen from Claude Desktop

Claude Desktop doesn't support plugins, but it can still talk to the MCP server. Register it once:

```bash
claude mcp add plannen -s user -- node "$(pwd)/mcp/dist/index.js"
```

This writes to `~/.claude.json`, which Claude Desktop reads on launch. Credentials come from `<repo-root>/.env` automatically (the MCP server loads it via dotenv), so no `-e` flags are needed. Restart Claude Desktop to pick up the registration.

To remove later: `claude mcp remove plannen -s user`.

---

## Before running `supabase db reset`

`supabase db reset` wipes the database. **Don't.** Use `supabase migration up` instead.

If you absolutely must reset, back up first:

```bash
bash scripts/export-seed.sh
```

This writes `supabase/seed.sql` and `supabase/seed-photos.tar.gz` (both gitignored). After reset, DB rows are restored automatically; restore photos with:

```bash
bash scripts/restore-photos.sh
```

This script extracts `seed-photos.tar.gz`, sets the `user.supabase.{cache-control,content-type,etag}` xattrs the storage worker reads (which `tar czf` strips), and inserts the matching `storage.objects` rows. Bare `tar xzf … -C /mnt` is **not** sufficient: files end up on disk but the storage API returns 404 (missing metadata row) or 500 ENODATA (missing xattrs). The script is idempotent — safe to re-run.

---

## Optional: Google Photos

For Claude-driven photo organisation of past events, configure Google OAuth:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Photos Library API**.
2. Generate OAuth 2.0 credentials of type **Web application**.
3. Register the OAuth callback as an authorised redirect URI:
   - **Tier 0**: `http://127.0.0.1:54323/functions/v1/google-oauth-callback`
   - **Tier 1**: `http://127.0.0.1:54321/functions/v1/google-oauth-callback`
4. Run `/plannen-setup` (in Claude Code) and paste the Client ID and Client Secret. Values are written to `.env` (and, in Tier 1, also to `supabase/functions/.env`). Restart the relevant process: Tier 0 → `bash scripts/backend-stop.sh && bash scripts/backend-start.sh`; Tier 1 → `bash scripts/functions-stop.sh && bash scripts/functions-start.sh`.

---

## Project layout

```
plannen/
├── src/                          # React app (Vite + TypeScript)
│   ├── lib/dbClient/             # Tier-portable data layer (tier0 fetch + tier1 supabase-js)
│   └── services/                 # Thin passthroughs to dbClient
├── mcp/                          # MCP server — pg.Pool + withUserContext, BOTH tiers
├── backend/                      # Tier 0 Hono backend (REST + storage + 12 function routes)
├── plugin/                       # Claude Code plugin (skills + commands + manifest)
├── supabase/
│   ├── migrations/               # Main schema (source of truth)
│   ├── migrations-tier0/         # Tier-0 compat overlay (auth/storage stubs + roles)
│   ├── functions/                # Edge functions — Deno entry per fn + pure handlers in _shared/handlers/
│   ├── config.toml               # Tier 1 Supabase config
│   └── seed*.{sql,tar.gz}        # Personal data backups (gitignored)
├── scripts/
│   ├── bootstrap.sh              # One-shot first-run install (--tier 0|1)
│   ├── start.sh / stop.sh        # Tier-aware umbrella lifecycle
│   ├── pg-{start,stop}.sh        # Embedded Postgres lifecycle (Tier 0)
│   ├── backend-{start,stop}.sh   # Plannen backend lifecycle (Tier 0)
│   ├── functions-{start,stop}.sh # Edge-functions lifecycle (Tier 1)
│   ├── local-start.sh            # Supabase start + Kong patch (Tier 1)
│   ├── export-seed.sh            # Backup local DB + photos (tier-aware)
│   ├── restore-photos.sh         # Restore photos (tier-aware)
│   └── lib/                      # Shared bash + node helpers (migrate, restore, dump-tables)
└── docs/
    ├── TIERED_DEPLOYMENT_MODEL.md  # Tier 0/1/2/3+ — where Postgres lives
    ├── INTEGRATIONS.md             # Google Calendar / Photos / Drive — orthogonal to tier
    └── superpowers/specs/          # Approved design docs
```

---

## Tips

These aren't Plannen-specific — they're general practice for anyone using Claude (Code, Desktop, the API) or running a local-first app with personal data. Worth doing once.

### 1. Don't share your Claude sessions for model training

How your prompts get used depends on which Anthropic surface you're on:

- **API key (Claude Code, Claude Desktop, MCP):** Anthropic's API/commercial policy is that customer prompts and outputs are **not used for training** by default. Nothing to toggle.
- **claude.ai subscription:** if you sign Claude Code into your claude.ai account instead of using a raw API key, claude.ai's privacy settings apply. Open [claude.ai/settings/privacy](https://claude.ai/settings/privacy) and turn **"Help improve Claude"** off.

### 2. Cap your Anthropic spend

Any app you paste an API key into — Plannen included — could leak it (logs, screenshots, backups). Bound the worst case up front:

1. [console.anthropic.com](https://console.anthropic.com) → **Workspaces** → create a workspace.
2. Set a **monthly spend limit** ($10–$20 is plenty for personal use).
3. **Generate an API key scoped to that workspace** and use *that* key everywhere.

If it leaks, blast radius is capped at your monthly limit. Revoke from Console without touching the rest of your Anthropic usage.

### 3. Back up your local data

For Plannen, `bash scripts/export-seed.sh` writes two files:

- `supabase/seed.sql` — DB rows
- `supabase/seed-photos.tar.gz` — photos

Both are gitignored. Copy them somewhere safe — cloud drive, external disk, whatever you already use for personal backups. If the contents are sensitive and you upload to a cloud provider, encrypt them first; that's your call.

To restore: drop the two files into `supabase/`, run `bootstrap.sh`, then `bash scripts/restore-photos.sh`.

---

## Troubleshooting

**Tier 0 — embedded Postgres won't come up on port 54322.** Check `~/.plannen/pg.log` for the error. If something else is bound to 54322 (e.g., a stale Supabase Docker container from a previous Tier 1 run), stop it first: `supabase stop --project-id plannen` and `bash scripts/pg-start.sh`.

**Tier 0 — backend says `ECONNREFUSED 127.0.0.1:54322`.** Postgres died (e.g., laptop sleep). `bash scripts/pg-start.sh` then `bash scripts/backend-stop.sh && bash scripts/backend-start.sh` to clear stale pool connections.

**Tier 1 — `supabase start` fails on Colima.** Ensure the docker socket is exposed: `colima start --network-address` plus `colima ssh -- sudo systemctl restart docker`. Some setups also need `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

**MCP doesn't start when Claude Code is launched as a GUI app.** The plugin manifest uses bare `node`, which isn't found if you installed Node via NVM and Claude Code doesn't inherit your shell's PATH. Workaround: symlink to a system-PATH location (e.g. `sudo ln -s "$(which node)" /usr/local/bin/node`). A per-machine plugin override is on the V1.1 backlog.

**Tier 1 — `/plannen-doctor` says functions-serve is dead.** `bash scripts/functions-start.sh` (idempotent — no-op if already alive). Check `.plannen/functions.log` for the error.

**I previously ran `scripts/install-plannen-command.sh`.** That installer is gone — the plugin replaces it. Clean up the stale slash command and MCP registration:

```bash
rm -f ~/.claude/commands/plannen.md
claude mcp remove plannen -s user 2>/dev/null || true
```

Then re-run `bash scripts/bootstrap.sh` (or, manually: `claude plugin marketplace add ./` then `claude plugin install plannen@plannen`).
