#!/usr/bin/env bash
# End-to-end integration test for the Tier 0 → Tier 1 migration path.
#
# DESTRUCTIVE — this stops your Tier 1 stack, flips .env to PLANNEN_TIER=0,
# then runs `bash scripts/bootstrap.sh --tier 1 --non-interactive` and asserts
# the migration carries over correctly. Run it only on a machine where it's
# OK to bounce the Tier 1 Docker stack; the test makes a fresh snapshot of
# Tier 1 first so you can recover by hand if anything goes sideways.
#
#   bash tests/integration/migrate-tier0-to-tier1.test.sh
#
# Preconditions:
#   - You're currently on Tier 1 (Docker stack up on 54322) with data.
#   - ~/.plannen/pgdata exists with the Tier 0 data you want to carry over.
#   - SUPABASE_SERVICE_ROLE_KEY is in .env.

set -euo pipefail

cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"
SNAPSHOT_DIR="$ROOT/.plannen/snapshots"
mkdir -p "$SNAPSHOT_DIR"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1m▶ %s\033[0m\n" "$*"; }

# ── 0. Safety: snapshot current Tier 1 state first ────────────────────────────
step "0. Pre-test snapshot of current Tier 1"
node "$ROOT/scripts/lib/snapshot.mjs" --tier 1 --out "$SNAPSHOT_DIR" --keep 10

# ── 1. Capture pre-migration metrics from Tier 1 ──────────────────────────────
step "1. Capture pre-migration counts (Tier 1)"
PRE_EVENTS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM plannen.events;")
PRE_MEMS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM plannen.event_memories;")
PRE_AUTH=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM auth.users;")
echo "Tier 1 has: $PRE_EVENTS events, $PRE_MEMS memories, $PRE_AUTH auth users"

# ── 2. Bring Tier 1 down, flip .env to PLANNEN_TIER=0 ─────────────────────────
step "2. Tear down Tier 1 + revert .env to PLANNEN_TIER=0"
supabase stop
sed -i.bak 's/^PLANNEN_TIER=.*/PLANNEN_TIER=0/' "$ENV_FILE"

# Make sure Tier 0 PG isn't running (so bootstrap can start it cleanly).
if [ -f "$HOME/.plannen/pg.pid" ]; then
  bash "$ROOT/scripts/pg-stop.sh" || true
fi

# ── 3. Verify Tier 0 has the source data ──────────────────────────────────────
step "3. Sanity-check Tier 0 has data to migrate"
bash "$ROOT/scripts/pg-start.sh"
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  nc -z 127.0.0.1 54322 2>/dev/null && break
done
T0_EVENTS=$(PGPASSWORD=plannen psql -h 127.0.0.1 -p 54322 -U plannen -d plannen -tAc "SELECT count(*) FROM plannen.events;")
T0_MEMS=$(PGPASSWORD=plannen psql -h 127.0.0.1 -p 54322 -U plannen -d plannen -tAc "SELECT count(*) FROM plannen.event_memories;")
echo "Tier 0 has: $T0_EVENTS events, $T0_MEMS memories"
bash "$ROOT/scripts/pg-stop.sh"

# ── 4. Run the bootstrap. This is the thing under test. ───────────────────────
step "4. bash scripts/bootstrap.sh --tier 1 --non-interactive"
bash "$ROOT/scripts/bootstrap.sh" --tier 1 --non-interactive

# ── 5. Verify post-migration state ────────────────────────────────────────────
step "5. Assert Tier 1 carries Tier 0's counts + has storage.objects"
POST_EVENTS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM plannen.events;")
POST_MEMS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM plannen.event_memories;")
POST_STORAGE=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM storage.objects WHERE bucket_id='event-photos';")
POST_AUTH=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT count(*) FROM auth.users;")

echo "Post-migration Tier 1: $POST_EVENTS events, $POST_MEMS memories, $POST_AUTH auth users, $POST_STORAGE storage.objects"

FAIL=0
[ "$POST_EVENTS" = "$T0_EVENTS" ] || { red "events: expected $T0_EVENTS, got $POST_EVENTS"; FAIL=1; }
[ "$POST_MEMS"   = "$T0_MEMS" ]   || { red "memories: expected $T0_MEMS, got $POST_MEMS"; FAIL=1; }
[ "$POST_STORAGE" -gt 0 ] || { red "storage.objects expected >0, got $POST_STORAGE"; FAIL=1; }

# ── 6. Verify a photo fetches via the public storage URL ──────────────────────
step "6. Fetch a sample photo via /storage/v1/object/public"
SAMPLE=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "SELECT name FROM storage.objects WHERE bucket_id='event-photos' AND name LIKE '%.jpg' LIMIT 1;")
if [ -n "$SAMPLE" ]; then
  HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:54321/storage/v1/object/public/event-photos/$SAMPLE")
  if [ "$HTTP" = "200" ]; then
    green "photo fetch: HTTP 200 ✓"
  else
    red "photo fetch: HTTP $HTTP"; FAIL=1
  fi
else
  echo "(no .jpg files in inventory — skipping fetch check)"
fi

# ── 7. Done ───────────────────────────────────────────────────────────────────
if [ $FAIL -eq 0 ]; then
  green "all assertions passed"
  exit 0
else
  red "integration test FAILED"
  echo "Recovery: your Tier 1 snapshot from step 0 lives in $SNAPSHOT_DIR"
  exit 1
fi
