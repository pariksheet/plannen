#!/usr/bin/env bash
# Umbrella start. Reads PLANNEN_TIER from .env and brings up the right stack.
#
# Tier 0: embedded Postgres → backend → web dev server
# Tier 1: Supabase Docker → functions-serve → web dev server
#
# Flags:
#   --no-dev   skip `npm run dev` (headless / MCP-only)
#
# All sub-scripts are idempotent, so re-running is safe.
# Suitable for wiring to login start-up (macOS LaunchAgent, systemd --user, etc).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/../.env"

START_DEV=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-dev) START_DEV=0; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE. Run 'bash scripts/bootstrap.sh' first." >&2
  exit 1
fi

TIER=$(grep -E '^PLANNEN_TIER=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo 0)
TIER=${TIER:-0}

echo "Starting Plannen (Tier $TIER)…"

if [ "$TIER" = "0" ]; then
  bash "$ROOT/pg-start.sh"
  bash "$ROOT/backend-start.sh"
else
  bash "$ROOT/local-start.sh"
  bash "$ROOT/functions-start.sh"
fi

if [ "$START_DEV" -eq 1 ]; then
  bash "$ROOT/dev-start.sh"
else
  echo "→ skipping web dev server (--no-dev)"
fi

echo "✓ started. Web app: http://localhost:4321  (set --no-dev to skip)"
