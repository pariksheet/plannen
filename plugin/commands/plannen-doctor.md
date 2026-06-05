---
description: Diagnose Plannen — tier-aware checks for env, embedded pg / Supabase, backend, MCP, plugin, AI key, Google keys.
argument-hint: ""
---

The user has invoked `/plannen-doctor`. Run a diagnostic battery, print pass / fail per check with a targeted single-command fix, and only suggest re-running bootstrap when ≥ 2 hard checks fail.

Do not modify anything. Read-only.

## Step 0 — resolve profile + tier (everything else depends on this)

1. Read the active profile from `~/.plannen/active` (fall back to `default`). Read its env file at `~/.plannen/profiles/<name>/env`; if the profile system isn't engaged, read `<repo>/.env` directly.
2. `PLANNEN_TIER` from that env decides which check set runs below. **Never run Tier 1 checks (Docker, `supabase status`, functions-serve) on a Tier 0 install — they produce false negatives that make a healthy setup look broken.**
3. Resolve the profile's ports with defaults: `PLANNEN_PG_PORT` (54322), `PLANNEN_BACKEND_PORT` (54323), `PLANNEN_WEB_PORT` (4321), and pid paths `PLANNEN_PG_PID` (`~/.plannen/pg.pid`), `PLANNEN_BACKEND_PID` (`~/.plannen/backend.pid`).
4. Print a header: `profile: <name>  tier: <N> (<mode>)`.

## Output format

Print one line per check:

- `✓` — pass
- `✗` — hard failure (something's broken; user can't proceed without fixing)
- `⚠` — warning (feature disabled but not broken)

After the list, print a summary: `N ok, M hard failures, K warnings`. If `M >= 2`, append the tail line about bootstrap.

## Common checks (all tiers)

1. **`.env` symlink consistent**: `<repo>/.env` is a symlink pointing at the *active* profile's env file.
   - Hard fail if it's a regular file or points at a different profile → `→ npx plannen profile use <active>`.

2. **`PLANNEN_USER_EMAIL` set** in the profile env.
   - Hard fail if missing → `→ /plannen-setup`.

## Tier 0 checks (`PLANNEN_TIER=0`)

3. **Port squatters**: for each of the pg/backend/web ports, `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
   - pg port held by a non-`postgres` process → hard fail naming it: `✗ pg port <port> held by <cmd> (pid <pid>) — likely a colima/Docker forward` → `→ stop it or use a profile with a different port offset`.
   - backend/web port held by something that isn't ours → warning naming the owner.

4. **Embedded Postgres up**: pid file at the profile's `PLANNEN_PG_PID` alive AND a `postgres` process listening on `PLANNEN_PG_PORT`.
   - Hard fail → `→ npx plannen up`.

5. **DATABASE_URL present** in the profile env and its port matches `PLANNEN_PG_PORT`.
   - Hard fail on missing → `→ npx plannen init --mode=local_pg` (idempotent).
   - Warning on port mismatch (stale env) → `→ npx plannen init --mode=local_pg`.

6. **Backend healthy**: `curl -s http://127.0.0.1:<PLANNEN_BACKEND_PORT>/health` returns `{"status":"ok", "tier":"0", "dbConnected":true}`.
   - Unreachable → hard fail → `→ npx plannen up`.
   - Reports a different tier → hard fail (env leakage; the backend is reading the wrong profile env) → `→ npx plannen down && npx plannen up`.
   - `dbConnected: false` → hard fail → check `DATABASE_URL` + pg status above.

7. **MCP build present** at `mcp/dist/index.js`, and `plugin/.claude-plugin/plugin.json` `mcpServers.plannen` is stdio (`{ "command": "node", ... }`).
   - Build missing → hard fail → `→ cd mcp && npm install && npm run build`.
   - plugin.json pointing at http in Tier 0 → warning → `→ bash scripts/mcp-mode.sh stdio`.

8. **MCP tool parity**: `node scripts/check-mcp-parity.mjs` exits 0.
   - Warning on drift (a tool will silently 404 in Tier 1/2 sessions) → the script's own output names the missing tools.

## Tier 1 checks (`PLANNEN_TIER=1`)

3. **Docker running**: `docker info` succeeds. Hard fail → start Docker/colima.

4. **Supabase reachable**: `curl -s -o /dev/null -w "%{http_code}" $SUPABASE_URL/rest/v1/ -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"` — pass on 200 or 401 (both prove reachable).
   - Hard fail → `→ npx plannen up` (or `bash scripts/local-start.sh`).

5. **Functions-serve running**: `.plannen/functions.pid` exists and the PID is alive.
   - Hard fail → `→ bash scripts/functions-start.sh`.

6. **MCP mode** — inspect `plugin/.claude-plugin/plugin.json` `mcpServers.plannen`:
   - `{ "type": "http", ... }` → verify `supabase/.env.local` contains `MCP_BEARER_TOKEN=` (warning if missing → `→ bash scripts/mcp-mode.sh http`), and the URL answers 401/200. Hard fail if unreachable → `→ supabase functions serve mcp --env-file supabase/.env.local`.
   - `{ "command": "node", ... }` → `✓ MCP mode: stdio`.

## Tier 2 checks (`PLANNEN_TIER=2`)

3. **Cloud Supabase reachable**: same curl as Tier 1 against the cloud `SUPABASE_URL`.
   - Hard fail → check the Supabase project status page / `npx plannen cloud provision`.

4. **Edge MCP reachable**: `$SUPABASE_URL/functions/v1/mcp` answers 401 (or 200 with bearer).
   - Hard fail → `→ supabase functions deploy mcp --project-ref <ref>`.

5. **Web deployed**: `PLANNEN_WEB_URL` answers < 500. Warning otherwise → `→ npx plannen deploy`.

## Cross-tier checks (after the tier set)

A. **Plannen user exists**. Use `mcp__plannen__get_profile_context` — if it returns successfully, pass. If it errors with "No Plannen account found":
   - Hard fail → Tier 0: `→ open http://localhost:<web port> and sign up`; Tier 1: `→ sign up at http://localhost:4321 (magic link at http://127.0.0.1:54324)`.

B. **Plugin installed in Claude Code**: `claude plugin list 2>/dev/null | grep -q plannen`.
   - Warning if absent → `→ claude plugin install ./plugin`.

C. **AI provider configured**. Query `user_settings`: a row with `is_default = true` and non-empty `api_key`?
   - Warning if not → `→ web app → /settings`. AI features disabled; Plannen still works. (Claude Code/Desktop users don't need this — it's web-UI-only.)

D. **whisper-cli availability**: `command -v whisper-cli`.
   - Warning if missing → `→ brew install whisper-cpp`. Story flow will skip audio.
   - Silent pass if `PLANNEN_WHISPER_MODEL=disabled`.

E. **whisper model file present** (only if D passed): file at `$PLANNEN_WHISPER_MODEL` (default `~/.plannen/whisper/ggml-base.en.bin`).
   - Warning → `→ curl -L -o ~/.plannen/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`.

F. **ffmpeg availability** (only if D passed): `command -v ffmpeg`.
   - Warning → `→ brew install ffmpeg`. Without it opus/m4a/webm audio silently fails.

G. **Google OAuth keys**: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in the profile env.
   - Warning if either is empty → `→ /plannen-setup`.

## Tail line (only when 2+ hard failures)

```
{N} hard failures detected. If targeted fixes don't resolve them, re-run
`npx plannen init --mode=<m>` — it's idempotent and re-establishes any
missing pieces.
```

For 0–1 hard failures, do not mention bootstrap. Single failures get only the targeted fix above.

## Example output (Tier 0)

```
profile: default  tier: 0 (local_pg)

✓ .env → ~/.plannen/profiles/default/env (active profile)
✓ PLANNEN_USER_EMAIL=you@example.com
✓ no squatters on 54322 / 54323 / 4321
✓ embedded Postgres up (pid 4242, port 54322)
✓ DATABASE_URL matches profile port
✓ backend healthy (tier 0, db connected)
✓ MCP build present at mcp/dist/index.js (stdio mode)
✓ MCP tool parity holds (57 local / 56 edge / 1 allowlisted)
✓ Plannen user exists for you@example.com
✓ Plugin installed in Claude Code
⚠ Anthropic key not configured
   → web app → /settings
✓ whisper-cli + model + ffmpeg present
✓ Google OAuth keys configured

Summary: 12 ok, 0 hard failures, 1 warning.
```
