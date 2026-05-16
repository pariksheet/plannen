#!/usr/bin/env bash
# Rotate MCP_BEARER_TOKEN for a Tier 2 (cloud) install.
#
#   bash scripts/mcp-rotate-bearer.sh
#
# Generates a new bearer, pushes it to the cloud project via `supabase secrets
# set`, then rewrites local .env + plugin/.claude-plugin/plugin.json. After
# this, reload the plannen plugin in Claude Code.
#
# Tier 0/1 are no-ops — they don't expose MCP over HTTP in cloud.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "no .env found — run bootstrap first" >&2
  exit 1
fi

TIER=$(grep -E '^PLANNEN_TIER=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
PROJECT_REF=$(grep -E '^SUPABASE_PROJECT_REF=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
SUPABASE_URL=$(grep -E '^SUPABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)

if [ "$TIER" != "2" ]; then
  echo "PLANNEN_TIER=$TIER; rotation only applies to Tier 2 (cloud)" >&2
  exit 1
fi
if [ -z "$PROJECT_REF" ]; then
  echo "SUPABASE_PROJECT_REF not set in .env" >&2
  exit 1
fi
if [ -z "$SUPABASE_URL" ]; then
  echo "SUPABASE_URL not set in .env" >&2
  exit 1
fi

SUPABASE_PROJECT_REF="$PROJECT_REF" SUPABASE_URL="$SUPABASE_URL" \
  node "$SCRIPT_DIR/lib/mcp-rotate-bearer.mjs"
