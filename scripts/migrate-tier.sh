#!/usr/bin/env bash
# Switch a Plannen install between tiers. Phase 1: only `1 0` is supported.
# See issue #8 for the status of Tier 0 → Tier 1.
#
# Usage:
#   bash scripts/migrate-tier.sh <from-tier> <to-tier> [--yes]
#
# What it does for 1→0:
#   1. Confirms current PLANNEN_TIER=1 and the Supabase Docker stack is up
#   2. Records row counts on Tier 1 (plannen.users, events, memories, stories)
#      and the file count in the storage container's /mnt
#   3. Runs scripts/export-seed.sh (Tier 1 mode) — writes supabase/seed.sql
#      and supabase/seed-photos.tar.gz
#   4. Stops the Tier 1 stack (Tier 0's embedded Postgres reuses port 54322,
#      so the two cannot run simultaneously)
#   5. Sets PLANNEN_TIER=0 in .env
#   6. Runs scripts/bootstrap.sh --tier 0 --non-interactive (uses
#      PLANNEN_USER_EMAIL from .env); a fresh ~/.plannen/pgdata triggers
#      auto-restore of seed.sql and seed-photos.tar.gz
#   7. Records row counts on Tier 0 and diffs them against the source
#
# Pre-conditions:
#   - .env's PLANNEN_TIER must equal <from-tier>
#   - .env's PLANNEN_USER_EMAIL must be set
#   - The Supabase stack (supabase_db_plannen, supabase_storage_plannen) must
#     be running
#   - ~/.plannen/pgdata must not already exist; pass --yes to wipe it first
#     (destructive — loses any existing Tier 0 data)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"

# ── Args ──────────────────────────────────────────────────────────────────────

FROM=""
TO=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    -h|--help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      err "unknown flag: $1"
      exit 1
      ;;
    *)
      if [ -z "$FROM" ]; then FROM=$1
      elif [ -z "$TO" ]; then TO=$1
      else err "unexpected argument: $1"; exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$FROM" ] || [ -z "$TO" ]; then
  err "usage: bash scripts/migrate-tier.sh <from-tier> <to-tier> [--yes]"
  exit 1
fi

if [ "$FROM" = "$TO" ]; then
  err "from-tier and to-tier are both $FROM — nothing to do"
  exit 1
fi

if [ "$FROM" != "1" ] || [ "$TO" != "0" ]; then
  cat >&2 <<EOF

  Only Tier 1 → Tier 0 is supported in this version of migrate-tier.sh.

  Tier 0 → Tier 1 is tracked in issue #8 — the photos layout converter
  and auth.users backfill aren't wired up yet. For now, switch tiers
  by hand using export-seed.sh + bootstrap.sh on the target tier.

EOF
  exit 1
fi

# ── Pre-flight ────────────────────────────────────────────────────────────────

step "Pre-flight"

ENV_FILE="$PROJECT_DIR/.env"
[ -f "$ENV_FILE" ] || { err ".env not found — run bootstrap.sh first"; exit 1; }

CURRENT_TIER=$(env_get "$ENV_FILE" PLANNEN_TIER)
if [ "$CURRENT_TIER" != "$FROM" ]; then
  err "PLANNEN_TIER in .env is '${CURRENT_TIER:-unset}', not '$FROM'. Aborting to avoid wrong-source export."
  exit 1
fi
ok "PLANNEN_TIER=$FROM in .env"

EMAIL=$(env_get "$ENV_FILE" PLANNEN_USER_EMAIL)
[ -n "$EMAIL" ] || { err "PLANNEN_USER_EMAIL not set in .env"; exit 1; }
ok "PLANNEN_USER_EMAIL=$EMAIL"

require_docker_running || exit 1

DB_CONTAINER="supabase_db_plannen"
STORAGE_CONTAINER="supabase_storage_plannen"
for c in "$DB_CONTAINER" "$STORAGE_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    err "container $c not running — start with: bash scripts/local-start.sh"
    exit 1
  fi
done
ok "Tier 1 stack running"

PGDATA="$HOME/.plannen/pgdata"
if [ -d "$PGDATA" ] && [ -n "$(ls -A "$PGDATA" 2>/dev/null || true)" ]; then
  if [ "$YES" -eq 1 ]; then
    warn "wiping $PGDATA (--yes)"
    if pid_alive "$HOME/.plannen/pg.pid"; then
      bash "$SCRIPT_DIR/pg-stop.sh" || true
    fi
    rm -rf "$PGDATA"
    ok "pgdata wiped"
  else
    err "$PGDATA already exists with data."
    err "Migration would not auto-restore the seed into an existing DB."
    err "Re-run with --yes to wipe it (destructive — loses any existing Tier 0 data)."
    exit 1
  fi
else
  ok "Tier 0 pgdata clear — bootstrap will init fresh"
fi

# ── 1. Source counts ──────────────────────────────────────────────────────────

step "1/6 Recording source counts (Tier 1)"

count_tier1() {
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tA -c "$1" 2>/dev/null | tr -d ' '
}

SRC_USERS=$(count_tier1 "SELECT count(*) FROM plannen.users")
SRC_EVENTS=$(count_tier1 "SELECT count(*) FROM plannen.events")
SRC_MEMORIES=$(count_tier1 "SELECT count(*) FROM plannen.event_memories")
SRC_STORIES=$(count_tier1 "SELECT count(*) FROM plannen.stories")
SRC_FILES=$(docker exec "$STORAGE_CONTAINER" sh -c 'find /mnt -mindepth 5 -type f 2>/dev/null | wc -l' | tr -d ' ')

printf "  %-22s %s\n"  "plannen.users"          "$SRC_USERS"
printf "  %-22s %s\n"  "plannen.events"         "$SRC_EVENTS"
printf "  %-22s %s\n"  "plannen.event_memories" "$SRC_MEMORIES"
printf "  %-22s %s\n"  "plannen.stories"        "$SRC_STORIES"
printf "  %-22s %s\n"  "photo files"            "$SRC_FILES"

# ── 2. Export ─────────────────────────────────────────────────────────────────

step "2/6 Exporting Tier 1 → supabase/seed.sql + seed-photos.tar.gz"
bash "$SCRIPT_DIR/export-seed.sh"

# ── 3. Stop Tier 1 ────────────────────────────────────────────────────────────

step "3/6 Stopping Tier 1 stack (port 54322 is reused by Tier 0)"
bash "$SCRIPT_DIR/functions-stop.sh" 2>&1 || true
if command -v supabase >/dev/null 2>&1; then
  echo "  → supabase stop --project-id plannen"
  supabase stop --project-id plannen 2>&1 | tail -5 || true
else
  warn "supabase CLI not found — stop the stack manually before bootstrap proceeds"
fi
# Confirm port 54322 is free
if nc -z 127.0.0.1 54322 2>/dev/null; then
  err "port 54322 still in use after stop attempt — abort and free it manually"
  exit 1
fi
ok "Tier 1 down"

# ── 4. Switch .env ────────────────────────────────────────────────────────────

step "4/6 Setting PLANNEN_TIER=0 in .env"
env_set "$ENV_FILE" PLANNEN_TIER 0
ok ".env updated"

# ── 5. Bootstrap Tier 0 ───────────────────────────────────────────────────────

step "5/6 Bootstrapping Tier 0 (auto-restores seed)"
bash "$SCRIPT_DIR/bootstrap.sh" --tier 0 --non-interactive --email "$EMAIL"

# ── 6. Verify ─────────────────────────────────────────────────────────────────

step "6/6 Recording target counts (Tier 0) and diffing"

DATABASE_URL_TIER0="postgres://plannen:plannen@127.0.0.1:54322/plannen"
count_tier0() {
  DATABASE_URL="$DATABASE_URL_TIER0" SQL="$1" node -e '
    const pg = require("pg");
    (async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(process.env.SQL);
      process.stdout.write(String(r.rows[0].count));
      await c.end();
    })().catch(e => { process.stderr.write(e.message + "\n"); process.exit(1) });
  '
}

DST_USERS=$(count_tier0 "SELECT count(*) FROM plannen.users")
DST_EVENTS=$(count_tier0 "SELECT count(*) FROM plannen.events")
DST_MEMORIES=$(count_tier0 "SELECT count(*) FROM plannen.event_memories")
DST_STORIES=$(count_tier0 "SELECT count(*) FROM plannen.stories")
PHOTOS_ROOT="${PLANNEN_PHOTOS_ROOT:-$HOME/.plannen/photos}"
DST_FILES=0
if [ -d "$PHOTOS_ROOT" ]; then
  DST_FILES=$(find "$PHOTOS_ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')
fi

diff_line() {
  local label=$1 src=$2 dst=$3
  if [ "$src" = "$dst" ]; then
    printf "  ${C_GREEN}✓${C_RESET} %-22s %s\n" "$label" "$dst"
  else
    printf "  ${C_RED}✗${C_RESET} %-22s %s (source had %s)\n" "$label" "$dst" "$src"
  fi
}

diff_line "plannen.users"          "$SRC_USERS"    "$DST_USERS"
diff_line "plannen.events"         "$SRC_EVENTS"   "$DST_EVENTS"
diff_line "plannen.event_memories" "$SRC_MEMORIES" "$DST_MEMORIES"
diff_line "plannen.stories"        "$SRC_STORIES"  "$DST_STORIES"
diff_line "photo files"            "$SRC_FILES"    "$DST_FILES"

FAIL=0
[ "$SRC_USERS"    = "$DST_USERS"    ] || FAIL=1
[ "$SRC_EVENTS"   = "$DST_EVENTS"   ] || FAIL=1
[ "$SRC_MEMORIES" = "$DST_MEMORIES" ] || FAIL=1
[ "$SRC_STORIES"  = "$DST_STORIES"  ] || FAIL=1
[ "$SRC_FILES"    = "$DST_FILES"    ] || FAIL=1

step "Done"

if [ $FAIL -eq 0 ]; then
  cat <<EOF

  ${C_GREEN}✓${C_RESET} Tier 1 → Tier 0 migration complete.

  Your data is now on embedded Postgres (127.0.0.1:54322) with photos at
  $PHOTOS_ROOT. The Tier 1 Docker volumes are untouched — you can switch
  back by running this again in reverse (once Phase 2 ships) or by hand.

  Export artifacts are kept at:
    supabase/seed.sql
    supabase/seed-photos.tar.gz

EOF
else
  cat <<EOF

  ${C_YELLOW}⚠${C_RESET} Migration ran to completion but counts don't match the source.
  Investigate before discarding the Tier 1 Docker volumes. Export
  artifacts are preserved at:
    supabase/seed.sql
    supabase/seed-photos.tar.gz

EOF
  exit 1
fi
