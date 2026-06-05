#!/usr/bin/env bash
# Start `supabase functions serve` in the background, idempotently.
# Writes PID to .plannen/functions.pid; logs to .plannen/functions.log.
# Re-running while the process is alive is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"
mkdir -p .plannen

PID_FILE=.plannen/functions.pid
LOG_FILE=.plannen/functions.log
ENV_FILE=supabase/functions/.env

if pid_alive "$PID_FILE"; then
  ok "supabase functions serve already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

# Stale PID file from a previous crashed run — clean it up.
rm -f "$PID_FILE"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "${ENV_FILE}.example" ]; then
    cp "${ENV_FILE}.example" "$ENV_FILE"
    dim "Created $ENV_FILE from template (Google OAuth values blank — set via /plannen-setup if needed)."
  else
    err "$ENV_FILE missing and no template at ${ENV_FILE}.example"
    exit 1
  fi
fi

# nohup so the process survives this shell exiting.
# Use bash -c to detach properly under set -e.
nohup supabase functions serve --env-file "$ENV_FILE" \
  >> "$LOG_FILE" 2>&1 &
SERVE_PID=$!
echo "$SERVE_PID" > "$PID_FILE"

# Brief liveness check — give it ~3s to bind ports / fail fast.
sleep 3
if pid_alive "$PID_FILE"; then
  ok "supabase functions serve started (PID $SERVE_PID)"
  dim "Logs:  tail -f $LOG_FILE"
  dim "Stop:  bash scripts/functions-stop.sh"
else
  rm -f "$PID_FILE"
  err "supabase functions serve died within 3s — see $LOG_FILE"
  tail -20 "$LOG_FILE" >&2 || true
  exit 1
fi
