#!/usr/bin/env bash
# Start the Tier 0 embedded Postgres in the background.
# PID is recorded at ~/.plannen/pg.pid. `pg-stop.sh` reads it for shutdown.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.plannen/pg.log"
mkdir -p "$HOME/.plannen"

# If a pid file exists and the process is alive, do nothing.
if [[ -f "$HOME/.plannen/pg.pid" ]] && kill -0 "$(cat "$HOME/.plannen/pg.pid")" 2>/dev/null; then
  echo "pg-start: already running (pid $(cat "$HOME/.plannen/pg.pid"))"
  exit 0
fi

nohup node "$HERE/lib/plannen-pg.mjs" start >> "$LOG" 2>&1 &
disown
sleep 2
if [[ -f "$HOME/.plannen/pg.pid" ]]; then
  echo "pg-start: spawned (pid $(cat "$HOME/.plannen/pg.pid")), log: $LOG"
else
  echo "pg-start: failed to write pid; tail $LOG"
  exit 1
fi
