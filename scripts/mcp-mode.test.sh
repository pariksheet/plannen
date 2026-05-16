#!/usr/bin/env bash
# Smoke tests for scripts/mcp-mode.sh. Uses a temp dir as a fake repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stage a fake plugin.json and supabase/ env layout.
mkdir -p "$TMP/plugin/.claude-plugin" "$TMP/supabase"
cat > "$TMP/plugin/.claude-plugin/plugin.json" <<EOF
{
  "name": "plannen",
  "version": "0.1.0",
  "mcpServers": {
    "plannen": { "command": "node", "args": ["\${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js"] }
  }
}
EOF

# --- Test 1: switch to http generates bearer and rewrites plugin.json ---
bash "$REPO_ROOT/scripts/mcp-mode.sh" http --root "$TMP" >/dev/null
grep -q '"type": "http"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json missing http type"; exit 1; }
grep -q 'Bearer ' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json missing Bearer header"; exit 1; }
grep -q '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" \
  || { echo "FAIL: supabase/.env.local missing MCP_BEARER_TOKEN"; exit 1; }

# --- Test 2: re-running http preserves the existing bearer ---
TOKEN_BEFORE=$(grep '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" | cut -d= -f2)
bash "$REPO_ROOT/scripts/mcp-mode.sh" http --root "$TMP" >/dev/null
TOKEN_AFTER=$(grep '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" | cut -d= -f2)
[ "$TOKEN_BEFORE" = "$TOKEN_AFTER" ] \
  || { echo "FAIL: bearer rotated on re-run (idempotency broken)"; exit 1; }

# --- Test 3: switch to stdio restores the stdio entry ---
bash "$REPO_ROOT/scripts/mcp-mode.sh" stdio --root "$TMP" >/dev/null
grep -q '"command": "node"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json did not restore stdio entry"; exit 1; }
! grep -q '"type": "http"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json still has http entry after stdio switch"; exit 1; }

echo "OK"
