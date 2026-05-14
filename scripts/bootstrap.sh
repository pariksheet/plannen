#!/usr/bin/env bash
# Plannen one-shot bootstrap. Runs all the first-install steps in sequence:
# prereq checks → email cascade → npm install → supabase start → migrations →
# auth user → write .env → functions serve (background) → plugin install →
# Claude Desktop hint → final printout. Idempotent: re-run is a no-op for
# everything that's already done.
#
# Usage:
#   bash scripts/bootstrap.sh                    # interactive
#   bash scripts/bootstrap.sh --non-interactive  # CI / scripted
#     [--email you@example.com]                  # required if PLANNEN_USER_EMAIL not in .env
#     [--install-plugin]                         # only installs the plugin in --non-interactive when set
#     [--start-dev]                              # only starts npm run dev in --non-interactive when set
#     [--configure-desktop]                      # only writes Claude Desktop MCP config in --non-interactive when set
#     [--install-skills]                         # only installs skills under ~/.claude/skills in --non-interactive when set
#
# See docs/superpowers/specs/2026-05-09-bootstrap-and-setup-story-design.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"

# ── Args ──────────────────────────────────────────────────────────────────────

NON_INTERACTIVE=0
INSTALL_PLUGIN=0
START_DEV=0
CONFIGURE_DESKTOP=0
INSTALL_SKILLS=0
ARG_EMAIL=""
PLUGIN_NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --email) ARG_EMAIL=$2; shift 2 ;;
    --email=*) ARG_EMAIL=${1#--email=}; shift ;;
    --install-plugin) INSTALL_PLUGIN=1; shift ;;
    --plugin) PLUGIN_NAMES+=("$2"); shift 2 ;;
    --plugin=*) PLUGIN_NAMES+=("${1#--plugin=}"); shift ;;
    --start-dev) START_DEV=1; shift ;;
    --configure-desktop) CONFIGURE_DESKTOP=1; shift ;;
    --install-skills) INSTALL_SKILLS=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── 1. Pre-flight ─────────────────────────────────────────────────────────────

step "1. Pre-flight checks"

FAIL=0
require_docker_running || FAIL=1
require_version node 20.0 "node --version" \
  "Install Node.js >= 20 LTS — https://nodejs.org or via nvm/asdf/volta" || FAIL=1
require_version supabase 2.0 "supabase --version" \
  "macOS:  brew install supabase/tap/supabase
Linux:  https://supabase.com/docs/guides/cli/getting-started" || FAIL=1
# bash version comes from $BASH_VERSION
BASH_V=${BASH_VERSION%%(*}
if version_ge "$BASH_V" "3.2"; then
  ok "bash $BASH_V"
else
  err "bash $BASH_V is too old; need >= 3.2"
  FAIL=1
fi
# claude is optional — only used in step 9
if command -v claude >/dev/null 2>&1; then
  ok "claude (optional, for plugin install)"
  CLAUDE_PRESENT=1
else
  warn "claude CLI not found — step 9 will print manual install instructions"
  CLAUDE_PRESENT=0
fi

[ $FAIL -eq 0 ] || { err "Pre-flight checks failed. Resolve above and re-run."; exit 1; }

# ── 2. Email cascade ──────────────────────────────────────────────────────────

step "2. Identifying your Plannen user"

ENV_FILE=.env
EXAMPLE_FILE=.env.example
EXISTING_EMAIL=$(env_get "$ENV_FILE" PLANNEN_USER_EMAIL)
GIT_EMAIL=$(git config user.email 2>/dev/null || true)

# Priority: --email > .env > git config user.email > prompt.
# An explicit --email overrides whatever's in .env so the user can attempt to
# switch identities (auth-user.mjs then enforces single-user-per-instance).
EMAIL=""
if [ -n "$ARG_EMAIL" ]; then
  EMAIL=$(lower "$ARG_EMAIL")
  ok "Using --email $EMAIL"
elif [ -n "$EXISTING_EMAIL" ]; then
  EMAIL=$EXISTING_EMAIL
  ok "Using existing PLANNEN_USER_EMAIL=$EMAIL from .env"
elif [ "$NON_INTERACTIVE" -eq 1 ]; then
  err "--non-interactive requires --email or PLANNEN_USER_EMAIL in .env"
  exit 1
else
  EMAIL=$(confirm_email "$GIT_EMAIL")
  EMAIL=$(lower "$EMAIL")
  ok "Confirmed: $EMAIL"
fi

# ── 3. Dependencies ───────────────────────────────────────────────────────────

step "3. Installing dependencies"

# Root npm install (Vite app + supabase-js for auth-user.mjs)
if [ -f package-lock.json ] && [ -d node_modules ]; then
  npm install --silent
else
  npm install
fi
ok "root npm install"

# MCP install + build
(
  cd mcp
  npm install --silent
  npm run build --silent
)
ok "mcp/ install + build"

# ── 4. Local Supabase ─────────────────────────────────────────────────────────

step "4. Starting local Supabase"

# local-start.sh is idempotent — `supabase start` no-ops if running and the
# Kong patch is overwrite-replace, so we always delegate.
bash scripts/local-start.sh

# ── 5. Migrations ─────────────────────────────────────────────────────────────

step "5. Applying migrations"

supabase migration up
ok "migrations applied"

# ── 6. Auth user ──────────────────────────────────────────────────────────────

step "6. Resolving auth.users row for $EMAIL"

# Pull the Supabase URL + service role key from .env.example for use here
# (these are demo keys when running against local; the user can override via
# .env after first install).
SUPABASE_URL_FOR_NODE=$(env_get "$EXAMPLE_FILE" SUPABASE_URL)
SERVICE_ROLE_FOR_NODE=$(env_get "$EXAMPLE_FILE" SUPABASE_SERVICE_ROLE_KEY)
# Allow .env to override if it has them
EXISTING_URL=$(env_get "$ENV_FILE" SUPABASE_URL)
EXISTING_KEY=$(env_get "$ENV_FILE" SUPABASE_SERVICE_ROLE_KEY)
[ -n "$EXISTING_URL" ] && SUPABASE_URL_FOR_NODE=$EXISTING_URL
[ -n "$EXISTING_KEY" ] && SERVICE_ROLE_FOR_NODE=$EXISTING_KEY

set +e
USER_UUID=$(SUPABASE_URL=$SUPABASE_URL_FOR_NODE \
            SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_FOR_NODE \
            node scripts/lib/auth-user.mjs "$EMAIL")
RC=$?
set -e
if [ $RC -eq 2 ]; then
  exit 2  # auth-user.mjs already printed the abort message
fi
[ $RC -eq 0 ] || { err "auth-user step failed"; exit 1; }
ok "auth user: $USER_UUID"

# ── 7. Write .env ─────────────────────────────────────────────────────────────

step "7. Writing .env"

merge_env "$EXAMPLE_FILE" "$ENV_FILE"
env_set "$ENV_FILE" PLANNEN_USER_EMAIL "$EMAIL"
ok "$ENV_FILE updated (existing values preserved)"

# Mirror the supabase/functions/.env scaffolding (functions-start.sh does
# this too, but doing it here makes step 7 the canonical 'write all .env files'
# step, and avoids surprise on first run).
FUNCTIONS_ENV=supabase/functions/.env
if [ ! -f "$FUNCTIONS_ENV" ] && [ -f "${FUNCTIONS_ENV}.example" ]; then
  cp "${FUNCTIONS_ENV}.example" "$FUNCTIONS_ENV"
  ok "$FUNCTIONS_ENV created from template (Google OAuth blank — add via /plannen-setup)"
fi

# ── 8. Functions serve (background) ───────────────────────────────────────────

step "8. Starting supabase functions serve in background"

bash scripts/functions-start.sh

# ── 8b. Web app dev server (background) ───────────────────────────────────────

step "8b. Web app dev server (npm run dev)"

DO_DEV=0
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  if [ "$START_DEV" -eq 1 ]; then
    DO_DEV=1
  else
    dim "skipping dev server (--non-interactive without --start-dev)"
  fi
else
  printf "  Start npm run dev in the background now? [Y/n]: "
  read -r answer
  case "$(lower "$answer")" in
    ""|y|yes) DO_DEV=1 ;;
    *) dim "skipped — start later with: bash scripts/dev-start.sh" ;;
  esac
fi
if [ "$DO_DEV" -eq 1 ]; then
  bash scripts/dev-start.sh
fi

# ── 9. Plugin install (Claude Code) ───────────────────────────────────────────

step "9. Claude Code plugin install"

DO_INSTALL=0
if [ "$CLAUDE_PRESENT" -eq 1 ]; then
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    if [ "$INSTALL_PLUGIN" -eq 1 ]; then
      DO_INSTALL=1
    else
      dim "skipping plugin install (--non-interactive without --install-plugin)"
    fi
  else
    printf "  Install Claude Code plugin now? [Y/n]: "
    read -r answer
    case "$(lower "$answer")" in
      ""|y|yes) DO_INSTALL=1 ;;
      *) dim "skipped — install later with: claude plugin marketplace add ./ && claude plugin install plannen@plannen" ;;
    esac
  fi
  if [ "$DO_INSTALL" -eq 1 ]; then
    # Two-step: register the local marketplace (idempotent — `add` no-ops if
    # already present), then install the plugin from it.
    if claude plugin marketplace add ./ 2>&1 | grep -qE 'Successfully added|already exists|already added'; then
      :
    else
      # Re-run to surface the actual error if it wasn't a benign "already present"
      claude plugin marketplace add ./ || true
    fi
    if claude plugin install plannen@plannen; then
      ok "plugin installed"
    else
      warn "plugin install failed; from inside a Claude Code session run: /plugin install plannen@plannen"
    fi
  fi
else
  dim "Claude Code not detected. To install the plugin later:"
  dim "  1. Install Claude Code:  https://claude.com/claude-code"
  dim "  2. From this repo's root:"
  dim "       claude plugin marketplace add ./"
  dim "       claude plugin install plannen@plannen"
fi

# ── 10. Claude Desktop config (auto-merge) ────────────────────────────────────

step "10. Claude Desktop MCP config"

DESKTOP_DIR=""
case "$(uname -s)" in
  Darwin) DESKTOP_DIR="$HOME/Library/Application Support/Claude" ;;
  Linux)  DESKTOP_DIR="$HOME/.config/Claude" ;;
esac

if [ -n "$DESKTOP_DIR" ] && [ -d "$DESKTOP_DIR" ]; then
  ABS_MCP_PATH="$PROJECT_DIR/mcp/dist/index.js"
  DESKTOP_CONFIG="$DESKTOP_DIR/claude_desktop_config.json"

  DO_DESKTOP=0
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    if [ "$CONFIGURE_DESKTOP" -eq 1 ]; then
      DO_DESKTOP=1
    else
      dim "skipping Claude Desktop config (--non-interactive without --configure-desktop)"
    fi
  else
    printf "  Detected Claude Desktop. Merge plannen MCP entry into claude_desktop_config.json now? [Y/n]: "
    read -r answer
    case "$(lower "$answer")" in
      ""|y|yes) DO_DESKTOP=1 ;;
      *) dim "skipped — re-run bootstrap or manually edit $DESKTOP_CONFIG" ;;
    esac
  fi

  if [ "$DO_DESKTOP" -eq 1 ]; then
    if [ ! -f "$ABS_MCP_PATH" ]; then
      err "MCP build artifact missing at $ABS_MCP_PATH — run 'cd mcp && npm run build'"
    elif [ -z "$SERVICE_ROLE_FOR_NODE" ]; then
      err "no SUPABASE_SERVICE_ROLE_KEY available to write into Claude Desktop config"
    else
      CONFIG_PATH="$DESKTOP_CONFIG" \
      MCP_SERVER_PATH="$ABS_MCP_PATH" \
      SUPABASE_URL="$SUPABASE_URL_FOR_NODE" \
      SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_FOR_NODE" \
      PLANNEN_USER_EMAIL="$EMAIL" \
      node "$SCRIPT_DIR/lib/claude-desktop-config.mjs" \
        && ok "Claude Desktop config updated — restart Claude Desktop to pick it up" \
        || warn "Claude Desktop config update failed — see message above"
    fi
  fi
else
  dim "Claude Desktop not detected — skipping"
fi

# ── 10b. Skills install (~/.claude/skills) ────────────────────────────────────

step "10b. Plannen skills for Claude Desktop / Claude.ai"

DO_SKILLS=0
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  if [ "$INSTALL_SKILLS" -eq 1 ]; then
    DO_SKILLS=1
  else
    dim "skipping skills install (--non-interactive without --install-skills)"
  fi
else
  cat <<EOF
  Plannen's plugin ships skills (intent gate, watch flow, story workflow…)
  that Claude Code loads from the plugin. Claude Desktop and Claude.ai don't
  see those — they read user skills from ~/.claude/skills. We can symlink
  Plannen's skills there so all surfaces share the same workflow logic.

  Skip this if you only use Claude Code with the plugin installed (which
  already loads them — installing twice would duplicate the entries).

EOF
  printf "  Install Plannen skills under ~/.claude/skills? [Y/n]: "
  read -r answer
  case "$(lower "$answer")" in
    ""|y|yes) DO_SKILLS=1 ;;
    *) dim "skipped — install later with: bash scripts/skills-install.sh" ;;
  esac
fi
if [ "$DO_SKILLS" -eq 1 ]; then
  bash scripts/skills-install.sh
fi

# ── 10c. Optional: whisper.cpp for audio transcription in stories ─────────────

step "Optional: whisper.cpp for audio transcription"

WHISPER_MODEL_DIR="$HOME/.plannen/whisper"
WHISPER_MODEL_FILE="$WHISPER_MODEL_DIR/ggml-base.en.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if command -v whisper-cli >/dev/null 2>&1; then
  echo "  whisper-cli already installed at $(command -v whisper-cli)"
else
  cat <<EOF
  Audio memories can be transcribed locally with whisper.cpp. This is OPTIONAL —
  audio uploads + plays without it; the story flow just won't see audio content.

    macOS:  brew install whisper-cpp
    Linux:  build from https://github.com/ggerganov/whisper.cpp

EOF
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    read -r -p "  Install via brew now? [y/N] " yn
    case "$yn" in
      [Yy]*)
        brew install whisper-cpp || dim "  brew install failed — install manually if you want this"
        ;;
      *)
        dim "  Skipped. You can run 'brew install whisper-cpp' later."
        ;;
    esac
  else
    dim "  No brew detected — install manually if you want this."
  fi
fi

if command -v whisper-cli >/dev/null 2>&1; then
  if [ -f "$WHISPER_MODEL_FILE" ]; then
    echo "  Model present at $WHISPER_MODEL_FILE"
  else
    read -r -p "  Download default model (ggml-base.en.bin, ~150 MB) to $WHISPER_MODEL_FILE? [y/N] " yn
    case "$yn" in
      [Yy]*)
        mkdir -p "$WHISPER_MODEL_DIR"
        if command -v curl >/dev/null 2>&1; then
          curl -L --fail -o "$WHISPER_MODEL_FILE" "$WHISPER_MODEL_URL" \
            || dim "  Download failed — fetch manually from $WHISPER_MODEL_URL"
        else
          dim "  curl missing — install curl or fetch manually"
        fi
        ;;
      *)
        dim "  Skipped. Download manually from $WHISPER_MODEL_URL"
        dim "  and place it at $WHISPER_MODEL_FILE (or set PLANNEN_WHISPER_MODEL)."
        ;;
    esac
  fi

  # ffmpeg — required to transcribe browser voice notes (opus/webm). whisper-cli's
  # bundled decoder only reliably handles wav/mp3/flac/Vorbis-in-ogg, so without
  # ffmpeg the stories skill silently fails on opus audio.
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "  ffmpeg present at $(command -v ffmpeg)"
  else
    cat <<EOF

  ffmpeg is recommended alongside whisper-cli. Browser voice notes are
  recorded as Opus, which whisper-cli can't decode on its own — ffmpeg
  converts them to WAV first.

EOF
    if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      read -r -p "  Install ffmpeg via brew now? [y/N] " yn
      case "$yn" in
        [Yy]*)
          brew install ffmpeg || dim "  brew install failed — install manually if you want this"
          ;;
        *)
          dim "  Skipped. You can run 'brew install ffmpeg' later."
          ;;
      esac
    else
      dim "  No brew detected — install ffmpeg manually if you want voice-note transcription."
    fi
  fi
fi

# ── 10d. Sibling plugins (--plugin) ───────────────────────────────────────────

if [ ${#PLUGIN_NAMES[@]} -gt 0 ]; then
  step "10d. Installing sibling plugins"
  for plugin_name in "${PLUGIN_NAMES[@]}"; do
    if [ "$plugin_name" = "all" ]; then
      for plugin_dir in plugins/*/; do
        if [ -x "${plugin_dir}install.sh" ]; then
          ok "Installing plugin: $(basename "$plugin_dir")"
          bash "${plugin_dir}install.sh" || err "Plugin install failed: $plugin_dir"
        fi
      done
    else
      plugin_dir="plugins/$plugin_name"
      if [ ! -d "$plugin_dir" ]; then
        err "Unknown plugin: $plugin_name (expected plugins/$plugin_name/ to exist)"
        exit 1
      fi
      if [ ! -x "$plugin_dir/install.sh" ]; then
        err "Plugin $plugin_name has no executable install.sh"
        exit 1
      fi
      ok "Installing plugin: $plugin_name"
      bash "$plugin_dir/install.sh" || err "Plugin install failed: $plugin_name"
    fi
  done
fi

# ── 11. Final printout ────────────────────────────────────────────────────────

step "Done"

cat <<EOF

  ${C_GREEN}✓${C_RESET} Plannen is configured for ${C_CYAN}$EMAIL${C_RESET}.

  Next steps:
    → Web app:    $(if [ -f .plannen/dev.pid ] && kill -0 "$(cat .plannen/dev.pid 2>/dev/null)" 2>/dev/null; then printf "running in background (PID %s) → http://localhost:4321\n                  Logs:  .plannen/dev.log\n                  Stop:  bash scripts/dev-stop.sh" "$(cat .plannen/dev.pid)"; else printf "npm run dev   →  http://localhost:4321"; fi)
    → Sign in:    enter $EMAIL, click "Magic link"
                  Link arrives at http://127.0.0.1:54324 (Mailpit)
    → AI key:     optional — only needed for AI features in the web app
                  (discovery, stories, image extraction).
                  web app → /settings → paste your Anthropic key
                  Skip if you only use Plannen via Claude Code / Desktop.
    → Functions:  running in background (PID $(cat .plannen/functions.pid 2>/dev/null || echo "?"))
                  Logs:  .plannen/functions.log
                  Stop:  bash scripts/functions-stop.sh

EOF
