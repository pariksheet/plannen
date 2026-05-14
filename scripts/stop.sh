#!/usr/bin/env bash
# Umbrella stop. Reads PLANNEN_TIER from .env and shuts down the right stack.
#
# Tier 0: dev server → backend → embedded Postgres
# Tier 1: dev server → functions-serve → Supabase Docker

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/../.env"

TIER=0
if [ -f "$ENV_FILE" ]; then
  TIER=$(grep -E '^PLANNEN_TIER=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo 0)
fi
TIER=${TIER:-0}

echo "Stopping Plannen (Tier $TIER)…"

bash "$ROOT/dev-stop.sh" 2>&1 || true

if [ "$TIER" = "0" ]; then
  bash "$ROOT/backend-stop.sh" 2>&1 || true
  bash "$ROOT/pg-stop.sh" 2>&1 || true
else
  bash "$ROOT/functions-stop.sh" 2>&1 || true
  echo "→ supabase stop --project-id plannen"
  supabase stop --project-id plannen 2>&1 | tail -5 || true
fi

echo "✓ stopped."
