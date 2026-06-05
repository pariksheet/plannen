#!/usr/bin/env bash
# Manual smoke test for the claude-code-cli AI provider.
# Verifies the CLI binary works end-to-end with a one-shot generate call.
# Run after implementing the provider; not part of CI.

set -euo pipefail

echo "== claude --version =="
claude --version

echo
echo "== one-shot generate (claude -p --output-format=json) =="
out=$(claude -p --output-format=json 'Reply with just the word "ok".')
echo "$out"

echo
echo "== checking wrapper shape =="
if echo "$out" | jq -e '.result' > /dev/null; then
  echo "OK — wrapper has .result"
else
  echo "FAIL — wrapper missing .result"
  exit 1
fi

result=$(echo "$out" | jq -r '.result')
echo "model said: $result"
