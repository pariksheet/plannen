#!/usr/bin/env bash
# Tier 1 → Tier 2 end-to-end smoke test.
#
# DESTRUCTIVE on cloud: this pushes the current Tier 1 plannen schema + data
# into a Supabase Cloud project AND deploys all edge functions there. Use a
# throwaway project — *not* your real Plannen cloud project — unless you
# accept the consequences.
#
#   TIER2_TEST_PROJECT_REF=xxxxxxxxxxxxxxxxxxxx \
#   TIER2_TEST_CLOUD_DB_URL='postgresql://postgres.<ref>:<pw>@<host>:6543/postgres' \
#     bash tests/smoke/tier2-bootstrap.sh
#
# Preconditions:
#   - On Tier 1 (Docker stack up; supabase start has run; data exists).
#   - `supabase login` has a session.
#   - .env has PLANNEN_USER_EMAIL set.
#
# What it covers:
#   1. snapshot current Tier 1
#   2. capture row counts (events, memories) and photo count
#   3. run `bash scripts/bootstrap.sh --tier 2 --non-interactive ...`
#   4. assert cloud counts match
#   5. run scripts/cloud-doctor.mjs
#   6. issue a real MCP tools/list call over HTTPS with the bearer
#   7. rollback: `bash scripts/bootstrap.sh --tier 1 --non-interactive` and
#      assert the local files are restored
#
# Exits 0 on green, non-zero on first failure.

set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1m▶ %s\033[0m\n" "$*"; }

if [ -z "${TIER2_TEST_PROJECT_REF:-}" ] || [ -z "${TIER2_TEST_CLOUD_DB_URL:-}" ]; then
  red "TIER2_TEST_PROJECT_REF and TIER2_TEST_CLOUD_DB_URL required"
  red "Use a throwaway cloud project — this is DESTRUCTIVE on cloud."
  exit 2
fi

if ! supabase projects list >/dev/null 2>&1; then
  red "supabase CLI is not logged in — run \`supabase login\` first"
  exit 2
fi

CUR_TIER=$(grep -E '^PLANNEN_TIER=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
if [ "$CUR_TIER" != "1" ]; then
  red "expected Tier 1 to start; .env shows PLANNEN_TIER=$CUR_TIER"
  exit 2
fi

# ── 1. Pre-migration counts ────────────────────────────────────────────────────
step "1. Capture pre-migration counts (local Tier 1)"
PRE_EVENTS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
  "SELECT count(*) FROM plannen.events;")
PRE_MEMS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
  "SELECT count(*) FROM plannen.event_memories;")
PRE_PHOTOS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
  "SELECT count(*) FROM storage.objects WHERE bucket_id = 'event-photos';")
echo "Tier 1: events=$PRE_EVENTS memories=$PRE_MEMS photos=$PRE_PHOTOS"

# ── 2. Run bootstrap --tier 2 ──────────────────────────────────────────────────
step "2. bootstrap --tier 2"
bash scripts/bootstrap.sh --tier 2 --non-interactive \
  --project-ref "$TIER2_TEST_PROJECT_REF" \
  --cloud-db-url "$TIER2_TEST_CLOUD_DB_URL" \
  ${FORCE_OVERWRITE:+--force-overwrite} \
  ${ACCEPT_STORAGE_QUOTA:+--accept-storage-quota}

# ── 3. Cloud counts ────────────────────────────────────────────────────────────
step "3. Capture post-migration counts (cloud)"
POST_EVENTS=$(psql "$TIER2_TEST_CLOUD_DB_URL" -tAc "SELECT count(*) FROM plannen.events;")
POST_MEMS=$(psql "$TIER2_TEST_CLOUD_DB_URL" -tAc "SELECT count(*) FROM plannen.event_memories;")
POST_PHOTOS=$(psql "$TIER2_TEST_CLOUD_DB_URL" -tAc \
  "SELECT count(*) FROM storage.objects WHERE bucket_id = 'event-photos';")
echo "Cloud: events=$POST_EVENTS memories=$POST_MEMS photos=$POST_PHOTOS"

assert_eq() {
  local label=$1 a=$2 b=$3
  if [ "$a" = "$b" ]; then
    green "  ✓ $label match ($a)"
  else
    red "  ✗ $label mismatch: tier1=$a cloud=$b"
    exit 1
  fi
}
assert_eq "events" "$PRE_EVENTS" "$POST_EVENTS"
assert_eq "memories" "$PRE_MEMS" "$POST_MEMS"
assert_eq "photos" "$PRE_PHOTOS" "$POST_PHOTOS"

# ── 4. Cloud doctor ────────────────────────────────────────────────────────────
step "4. cloud-doctor.mjs"
SUPABASE_URL="https://${TIER2_TEST_PROJECT_REF}.supabase.co" \
MCP_BEARER_TOKEN="$(grep -E '^MCP_BEARER_TOKEN=' .env | cut -d= -f2-)" \
PLANNEN_USER_EMAIL="$(grep -E '^PLANNEN_USER_EMAIL=' .env | cut -d= -f2-)" \
CLOUD_DATABASE_URL="$TIER2_TEST_CLOUD_DB_URL" \
TIER1_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" \
  node scripts/cloud-doctor.mjs

# ── 5. Real MCP tools/list over HTTPS ─────────────────────────────────────────
step "5. MCP tools/list over HTTPS"
BEARER=$(grep -E '^MCP_BEARER_TOKEN=' .env | cut -d= -f2-)
MCP_URL="https://${TIER2_TEST_PROJECT_REF}.supabase.co/functions/v1/mcp"
TOOLS_COUNT=$(curl -fsS -X POST "$MCP_URL" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node -e 'process.stdin.on("data",b=>{const x=JSON.parse(b);process.stdout.write(String((x.result?.tools||[]).length))})')
echo "  tools returned: $TOOLS_COUNT"
if [ "$TOOLS_COUNT" -lt 1 ]; then
  red "expected ≥1 tool; got $TOOLS_COUNT"
  exit 1
fi
green "  ✓ MCP responded with $TOOLS_COUNT tool(s)"

# ── 6. Rollback to Tier 1 ─────────────────────────────────────────────────────
step "6. Rollback: bootstrap --tier 1"
bash scripts/bootstrap.sh --tier 1 --non-interactive
ROLLBACK_TIER=$(grep -E '^PLANNEN_TIER=' .env | cut -d= -f2)
if [ "$ROLLBACK_TIER" != "1" ]; then
  red "rollback failed: .env still shows PLANNEN_TIER=$ROLLBACK_TIER"
  exit 1
fi
green "  ✓ rolled back to Tier 1"

green "tier 2 smoke: PASS"
