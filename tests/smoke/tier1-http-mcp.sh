#!/usr/bin/env bash
# End-to-end smoke for Tier 1 HTTP MCP. Run from repo root with local Supabase
# already up. Exits non-zero on any check failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Reset to a known mode and back so the toggle is exercised.
bash scripts/mcp-mode.sh http >/dev/null
TOKEN=$(grep '^MCP_BEARER_TOKEN=' supabase/.env.local | head -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "FAIL: no bearer in supabase/.env.local"; exit 1; }

# Start `supabase functions serve mcp` in the background.
supabase functions serve mcp --env-file supabase/.env.local > /tmp/mcp-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT

# Wait up to 15s for the server to come up.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/functions/v1/mcp | grep -q '401'; then
    break
  fi
  sleep 0.5
done

# Validate auth rejection (no bearer → 401).
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/functions/v1/mcp)
[ "$CODE" = "401" ] || { echo "FAIL: expected 401 without bearer, got $CODE"; exit 1; }

# Validate tools/list returns the expected tool count.
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:54321/functions/v1/mcp)
COUNT=$(echo "$RESP" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')
[ "$COUNT" -ge 37 ] || { echo "FAIL: expected >=37 tools, got $COUNT"; echo "$RESP" | head; exit 1; }

# Validate transcribe_memory is absent (Phase A drop).
echo "$RESP" | grep -q '"transcribe_memory"' && { echo "FAIL: transcribe_memory should be dropped in Phase A"; exit 1; }

echo "OK ($COUNT tools registered)"
