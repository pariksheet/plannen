#!/usr/bin/env bash
# Toggle the plannen plugin's MCP entry between stdio (default, Node-based)
# and HTTP (new in Phase A, Edge Function based).
#
#   bash scripts/mcp-mode.sh stdio
#   bash scripts/mcp-mode.sh http
#
# Flags:
#   --root <path>   Override repo root (used by tests; defaults to script's parent).

set -euo pipefail

MODE="${1:-}"
shift || true

ROOT_DEFAULT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$ROOT_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

PLUGIN_JSON="$ROOT/plugin/.claude-plugin/plugin.json"
ENV_FILE="$ROOT/supabase/.env.local"
HTTP_URL="http://127.0.0.1:54321/functions/v1/mcp"

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "plugin.json not found at $PLUGIN_JSON" >&2
  exit 1
fi

case "$MODE" in
  http)
    mkdir -p "$(dirname "$ENV_FILE")"
    if [ -f "$ENV_FILE" ] && grep -q '^MCP_BEARER_TOKEN=' "$ENV_FILE"; then
      TOKEN=$(grep '^MCP_BEARER_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2)
    else
      TOKEN=$(openssl rand -hex 32)
      touch "$ENV_FILE"
      # Strip any partial line then append.
      grep -v '^MCP_BEARER_TOKEN=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
      mv "$ENV_FILE.tmp" "$ENV_FILE"
      echo "MCP_BEARER_TOKEN=$TOKEN" >> "$ENV_FILE"
    fi

    # Rewrite plugin.json.mcpServers.plannen to the HTTP entry. node -e keeps
    # JSON formatting predictable across systems where jq may not be installed.
    node -e "
      const fs = require('fs');
      const path = '$PLUGIN_JSON';
      const j = JSON.parse(fs.readFileSync(path, 'utf8'));
      j.mcpServers = j.mcpServers || {};
      j.mcpServers.plannen = {
        type: 'http',
        url: '$HTTP_URL',
        headers: { Authorization: 'Bearer $TOKEN' },
      };
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    echo "→ HTTP MCP configured. Reload the plannen plugin in Claude Code to apply."
    ;;

  stdio)
    node -e "
      const fs = require('fs');
      const path = '$PLUGIN_JSON';
      const j = JSON.parse(fs.readFileSync(path, 'utf8'));
      j.mcpServers = j.mcpServers || {};
      j.mcpServers.plannen = {
        command: 'node',
        args: ['\${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js'],
      };
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    echo "→ stdio MCP configured. Reload the plannen plugin in Claude Code to apply."
    ;;

  *)
    cat <<EOF
Usage: $0 stdio|http [--root <path>]

  stdio   Restore the default Node-stdio MCP entry in plugin.json.
  http    Generate a bearer token (or reuse the existing one), write it to
          supabase/.env.local, rewrite plugin.json's mcpServers.plannen entry
          to point at the local HTTP Edge Function MCP.
EOF
    exit 1
    ;;
esac
