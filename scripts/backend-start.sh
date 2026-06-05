#!/usr/bin/env bash
# Start the Plannen backend (Hono) in the background.
# PID at ~/.plannen/backend.pid. Probes /health to confirm readiness.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BACKEND_DIR="$REPO/backend"
# Per-profile pid/log (#7); legacy global defaults keep old installs working.
LOG="${PLANNEN_BACKEND_LOG:-$HOME/.plannen/backend.log}"
PID="${PLANNEN_BACKEND_PID:-$HOME/.plannen/backend.pid}"
mkdir -p "$HOME/.plannen" "$(dirname "$PID")" "$(dirname "$LOG")"

# Load env so PLANNEN_USER_EMAIL / DATABASE_URL / PLANNEN_BACKEND_PORT propagate.
# Caller-provided values win over the repo .env symlink — the symlink tracks
# the *active* profile, but init/up may target a different one (#13).
PRESET_BACKEND_PORT="${PLANNEN_BACKEND_PORT:-}"
PRESET_DATABASE_URL="${DATABASE_URL:-}"
PRESET_USER_EMAIL="${PLANNEN_USER_EMAIL:-}"
PRESET_TIER="${PLANNEN_TIER:-}"
if [[ -f "$REPO/.env" ]]; then
  set -a; source "$REPO/.env"; set +a
fi
[[ -n "$PRESET_BACKEND_PORT" ]] && export PLANNEN_BACKEND_PORT="$PRESET_BACKEND_PORT"
[[ -n "$PRESET_DATABASE_URL" ]] && export DATABASE_URL="$PRESET_DATABASE_URL"
[[ -n "$PRESET_USER_EMAIL" ]] && export PLANNEN_USER_EMAIL="$PRESET_USER_EMAIL"
[[ -n "$PRESET_TIER" ]] && export PLANNEN_TIER="$PRESET_TIER"
# Tell the backend where its env file lives so POST /api/me can rewrite
# PLANNEN_USER_EMAIL when the user signs up via the web UI. Callers (init)
# pass the profile env path; default to the repo .env symlink.
export PLANNEN_ENV_PATH="${PLANNEN_ENV_PATH:-$REPO/.env}"

# Already running? bail without restarting.
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "backend-start: already running (pid $(cat "$PID"))"
  exit 0
fi

# Foreign listener on our port? Warn with the owner's name — wildcard forwards
# (e.g. Supabase Studio via colima) can coexist with our loopback bind but make
# failures confusing (#14). The /health probe below stays the arbiter.
PORT="${PLANNEN_BACKEND_PORT:-54323}"
# `|| true`: lsof exits 1 when the port is free — that's the happy path, and
# set -e would otherwise kill the script on this assignment.
SQUATTER="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}' || true)"
if [[ -n "$SQUATTER" ]]; then
  echo "backend-start: WARNING — port ${PORT} already has a listener: ${SQUATTER}. If startup fails or /health misbehaves, stop it or use a profile with a different port offset." >&2
fi

# Build on first run (or after a clean).
if [[ ! -f "$BACKEND_DIR/dist/index.js" ]]; then
  echo "backend-start: dist missing, building…"
  (cd "$BACKEND_DIR" && npm run build)
fi

cd "$BACKEND_DIR"
nohup node dist/index.js >> "$LOG" 2>&1 &
echo $! > "$PID"
disown
sleep 1

if curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null; then
  echo "backend-start: started (pid $(cat "$PID")), port $PORT, log: $LOG"
else
  echo "backend-start: /health did not respond on port $PORT; tail $LOG"
  exit 1
fi
