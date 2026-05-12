---
description: Re-configure Plannen — edit your email, Supabase URL/keys, or Google OAuth in .env. Use bootstrap.sh for first-time install.
argument-hint: ""
---

The user has invoked `/plannen-setup`. This command **edits `.env` only** — re-config for an already-bootstrapped Plannen install. First-time setup goes through `bash scripts/bootstrap.sh` instead; if there is no `.env` yet, point the user there.

## Editable surface

Only these fields. Anything else is out of scope.

| Field | When to edit |
|---|---|
| `PLANNEN_USER_EMAIL` | The user wants to switch identity (rare). Triggers an auth-user check — see below. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Pointing at hosted Supabase instead of local. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Most common reason — adding Google Photos OAuth after first install. Update both root `.env` AND `supabase/functions/.env`. |

The Anthropic AI key is **not** in `.env`. Direct the user to the web app's `/settings` page for that — it lives in the `user_settings` DB table per the BYOK design.

## Workflow

1. **Read `.env`.** If missing, tell the user: *"No `.env` found. This is a first-time install — run `bash scripts/bootstrap.sh` from the repo root, not this command."* Stop.

2. **Show current values** masked where sensitive:
   - `PLANNEN_USER_EMAIL`: shown
   - `SUPABASE_URL`: shown
   - `SUPABASE_SERVICE_ROLE_KEY`: masked (last 6 chars only)
   - `GOOGLE_CLIENT_ID`: shown if set, else "not set"
   - `GOOGLE_CLIENT_SECRET`: masked / "not set"

3. **Ask which to change.** Multi-select; default to nothing. Don't update what wasn't asked.

4. **For `PLANNEN_USER_EMAIL`:** before writing the new value, run `node scripts/lib/auth-user.mjs <new-email>`. If it exits 2 (different user already exists), abort and surface the message verbatim — don't write anything. Otherwise proceed.

5. **Write `.env`** in place using the existing values where the user didn't change anything. For `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, write to BOTH `.env` and `supabase/functions/.env`.

6. **Run `/plannen-doctor`** and report the result. If `PLANNEN_USER_EMAIL` changed, additionally tell the user: *"MCP server needs to reconnect — restart Claude Code or use `/mcp` to reconnect plannen."*

## What this command does NOT do

- Install npm deps, build MCP, run migrations.
- Manage `functions-serve` lifecycle (use `bash scripts/functions-start.sh` / `functions-stop.sh`).
- Install the plugin (use `claude plugin install ./plugin`).
- Touch `ANTHROPIC_API_KEY` (use the web app's `/settings`).
- Run a full bootstrap. If the user wants that, point them at `bash scripts/bootstrap.sh`.
