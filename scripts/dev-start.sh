#!/usr/bin/env bash
# Start `npm run dev` (Vite) in the background, idempotently.
# Writes PID to .plannen/dev.pid; logs to .plannen/dev.log.
# Re-running while the process is alive is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"
mkdir -p .plannen

# Per-profile pid/log/port (#7); repo-local defaults keep old installs working.
PID_FILE="${PLANNEN_DEV_PID:-.plannen/dev.pid}"
LOG_FILE="${PLANNEN_DEV_LOG:-.plannen/dev.log}"
WEB_PORT="${PLANNEN_WEB_PORT:-4321}"
mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if pid_alive "$PID_FILE"; then
  ok "npm run dev already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

# Stale PID file from a previous crashed run — clean it up.
rm -f "$PID_FILE"

if [ ! -d node_modules ]; then
  err "node_modules missing — run 'npm install' first"
  exit 1
fi

nohup npm run dev >> "$LOG_FILE" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$PID_FILE"

# Brief liveness check — give Vite ~3s to bind the web port / fail fast.
sleep 3
if pid_alive "$PID_FILE"; then
  ok "npm run dev started (PID $DEV_PID) — http://localhost:${WEB_PORT}"
  dim "Logs:  tail -f $LOG_FILE"
  dim "Stop:  bash scripts/dev-stop.sh"
else
  rm -f "$PID_FILE"
  err "npm run dev died within 3s — see $LOG_FILE"
  tail -20 "$LOG_FILE" >&2 || true
  exit 1
fi
