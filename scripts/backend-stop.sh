#!/usr/bin/env bash
# Stop the Plannen backend. Idempotent: missing pid file is success.
set -euo pipefail
PID="$HOME/.plannen/backend.pid"
if [[ ! -f "$PID" ]]; then
  echo "backend-stop: no pid file; nothing to stop"
  exit 0
fi
if kill -0 "$(cat "$PID")" 2>/dev/null; then
  kill -TERM "$(cat "$PID")"
  echo "backend-stop: sent SIGTERM to $(cat "$PID")"
else
  echo "backend-stop: stale pid file"
fi
rm -f "$PID"
