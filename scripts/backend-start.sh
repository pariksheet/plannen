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
if [[ -f "$REPO/.env" ]]; then
  set -a; source "$REPO/.env"; set +a
fi

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
