#!/usr/bin/env bash
# Stop the background `supabase functions serve` started by
# scripts/functions-start.sh (or scripts/bootstrap.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"

PID_FILE=.plannen/functions.pid

if [ ! -f "$PID_FILE" ]; then
  ok "supabase functions serve is not running (no PID file)"
  exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null || true)
if [ -z "$PID" ]; then
  rm -f "$PID_FILE"
  ok "removed stale empty PID file"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  # Give it up to 5s to exit cleanly, then SIGKILL.
  for _ in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  ok "stopped supabase functions serve (PID $PID)"
else
  ok "supabase functions serve already stopped"
fi
rm -f "$PID_FILE"
