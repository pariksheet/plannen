#!/usr/bin/env bash
# Start the Tier 0 embedded Postgres in the background.
# PID is recorded at ~/.plannen/pg.pid. `pg-stop.sh` reads it for shutdown.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Per-profile pid/log (#7); legacy global defaults keep old installs working.
PID="${PLANNEN_PG_PID:-$HOME/.plannen/pg.pid}"
LOG="${PLANNEN_PG_LOG:-$HOME/.plannen/pg.log}"
mkdir -p "$HOME/.plannen" "$(dirname "$PID")" "$(dirname "$LOG")"

# If a pid file exists and the process is alive, do nothing.
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "pg-start: already running (pid $(cat "$PID"))"
  exit 0
fi

# The alive check above failed, so any remaining pid file is stale — remove it
# so a failed start below can't masquerade as success.
rm -f "$PID"

nohup node "$HERE/lib/plannen-pg.mjs" start >> "$LOG" 2>&1 &
disown
sleep 2
if [[ -f "$PID" ]]; then
  echo "pg-start: spawned (pid $(cat "$PID")), log: $LOG"
else
  echo "pg-start: failed to start; recent log:"
  tail -3 "$LOG" 2>/dev/null || true
  exit 1
fi
