#!/usr/bin/env bash
# Start the Plannen backend (Hono) in the background.
# PID at ~/.plannen/backend.pid. Probes /health to confirm readiness.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BACKEND_DIR="$REPO/backend"
LOG="$HOME/.plannen/backend.log"
PID="$HOME/.plannen/backend.pid"
mkdir -p "$HOME/.plannen"

# Load env so PLANNEN_USER_EMAIL / DATABASE_URL / PLANNEN_BACKEND_PORT propagate.
# Caller-provided values win over the repo .env symlink — the symlink tracks
# the *active* profile, but init/up may target a different one (#13).
PRESET_BACKEND_PORT="${PLANNEN_BACKEND_PORT:-}"
PRESET_DATABASE_URL="${DATABASE_URL:-}"
PRESET_USER_EMAIL="${PLANNEN_USER_EMAIL:-}"
if [[ -f "$REPO/.env" ]]; then
  set -a; source "$REPO/.env"; set +a
fi
[[ -n "$PRESET_BACKEND_PORT" ]] && export PLANNEN_BACKEND_PORT="$PRESET_BACKEND_PORT"
[[ -n "$PRESET_DATABASE_URL" ]] && export DATABASE_URL="$PRESET_DATABASE_URL"
[[ -n "$PRESET_USER_EMAIL" ]] && export PLANNEN_USER_EMAIL="$PRESET_USER_EMAIL"
# Tell the backend where its env file lives so POST /api/me can rewrite
# PLANNEN_USER_EMAIL when the user signs up via the web UI. Callers (init)
# pass the profile env path; default to the repo .env symlink.
export PLANNEN_ENV_PATH="${PLANNEN_ENV_PATH:-$REPO/.env}"

# Already running? bail without restarting.
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "backend-start: already running (pid $(cat "$PID"))"
  exit 0
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

PORT="${PLANNEN_BACKEND_PORT:-54323}"
if curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null; then
  echo "backend-start: started (pid $(cat "$PID")), port $PORT, log: $LOG"
else
  echo "backend-start: /health did not respond on port $PORT; tail $LOG"
  exit 1
fi
