---
description: Diagnose Plannen — verifies env, Supabase, MCP, plugin, functions-serve, AI key, Google keys.
argument-hint: ""
---

The user has invoked `/plannen-doctor`. Run a diagnostic battery, print pass / fail per check with a targeted single-command fix, and only suggest re-running bootstrap when ≥ 2 hard checks fail.

Do not modify anything. Read-only.

## Output format

Print one line per check:

- `✓` — pass
- `✗` — hard failure (something's broken; user can't proceed without fixing)
- `⚠` — warning (feature disabled but not broken)

After the list, print a summary: `N ok, M hard failures, K warnings`. If `M >= 2`, append the tail line about bootstrap.

## Checks

In order:

1. **`.env` present** at the repo root.
   - Pass: file exists.
   - Hard fail: file missing → `→ bash scripts/bootstrap.sh` (this is first-time install territory, not /plannen-setup).

2. **`PLANNEN_USER_EMAIL` set** in `.env`.
   - Hard fail if missing → `→ /plannen-setup`.

3. **Supabase reachable**. Try `curl -s -o /dev/null -w "%{http_code}" $SUPABASE_URL/rest/v1/ -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"`. Pass on 200 or 401 (both prove reachable).
   - Hard fail → `→ bash scripts/local-start.sh`.

4. **Plannen user exists**. Use `mcp__plannen__get_profile_context` — if it returns successfully, the auth user exists. If it errors with "No Plannen account found":
   - Hard fail → `→ Sign up at http://localhost:4321 (magic link arrives at http://127.0.0.1:54324)`.

5. **MCP build present** at `mcp/dist/index.js`.
   - Hard fail → `→ cd mcp && npm install && npm run build`.

6. **Plugin installed in Claude Code**. Check `claude plugin list 2>/dev/null | grep -q plannen`.
   - Warning if absent → `→ claude plugin install ./plugin` (functional already; Claude Code just won't auto-load workflows).

7. **Functions-serve running**. Check `.plannen/functions.pid` — if file exists and the PID is alive, pass.
   - Hard fail otherwise → `→ bash scripts/functions-start.sh`.

8. **AI provider configured**. Query `user_settings` (via the auth user from check 4): is there a row with `is_default = true` and a non-empty `api_key`?
   - Warning if not → `→ web app → /settings`. AI features are disabled but Plannen still works.

9. **whisper-cli availability**. Try `command -v whisper-cli`.
   - Pass: present.
   - Warning if missing → `→ brew install whisper-cpp` (mac) or build from https://github.com/ggerganov/whisper.cpp. Story flow will skip audio.
   - Skipped (silent pass) if `PLANNEN_WHISPER_MODEL=disabled` in `.env`.

10. **whisper model file present** (only checked if check 9 passed).
    - Pass: file at `$PLANNEN_WHISPER_MODEL` (or `~/.plannen/whisper/ggml-base.en.bin` if unset) exists.
    - Warning otherwise → `→ download a model: curl -L -o ~/.plannen/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`.

11. **ffmpeg availability** (only checked if check 9 passed). Try `command -v ffmpeg`.
    - Pass: present. Browser voice notes (opus/webm) will transcribe correctly.
    - Warning if missing → `→ brew install ffmpeg`. Without it, whisper-cli silently fails on opus/m4a/webm audio (only mp3/wav/flac decode reliably).

12. **Google OAuth keys**. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
    - Warning if either is empty → `→ /plannen-setup` (and configure the OAuth client per the README).

## Tail line (only when 2+ hard failures)

```
{N} hard failures detected. If targeted fixes don't resolve them, re-run
`bash scripts/bootstrap.sh` — it's idempotent and re-establishes any
missing pieces.
```

For 0–1 hard failures, do not mention bootstrap. Single failures get only the targeted fix above.

## Example output

```
✓ .env present at /Users/you/plannen/.env
✓ PLANNEN_USER_EMAIL=you@example.com
✓ Supabase reachable (http://127.0.0.1:54321)
✓ Plannen user exists for you@example.com
✓ MCP build present at mcp/dist/index.js
✓ Plugin installed in Claude Code
✓ Functions-serve running
⚠ Anthropic key not configured
   → web app → /settings
⚠ whisper-cli not installed — audio transcription disabled
   → brew install whisper-cpp
⚠ whisper model file missing at ~/.plannen/whisper/ggml-base.en.bin
   → curl -L -o ~/.plannen/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
⚠ ffmpeg not installed — opus/m4a/webm audio will fail to transcribe
   → brew install ffmpeg
✓ Google OAuth keys configured

Summary: 8 ok, 0 hard failures, 4 warnings.
```
