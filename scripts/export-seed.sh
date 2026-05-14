#!/usr/bin/env bash
# Export current local DB + event-photos.
#
# Writes:
#   supabase/seed.sql           — DB rows (auto-loaded by Tier 1's `supabase
#                                  db reset` AND by Tier 0's bootstrap on a
#                                  fresh ~/.plannen/pgdata init).
#   supabase/seed-photos.tar.gz — photo blobs.
#
# Tier 0: dumps via `pg_dump` against 127.0.0.1:54322 (embedded pg) and tars
#         ~/.plannen/photos/ (or $PLANNEN_PHOTOS_ROOT).
# Tier 1: dumps via `docker exec supabase_db_plannen` and tars the storage
#         container's /mnt (which preserves the xattrs the storage worker reads).
#
# Reads PLANNEN_TIER from .env (default 0).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SQL_OUT="$ROOT/supabase/seed.sql"
PHOTOS_OUT="$ROOT/supabase/seed-photos.tar.gz"

TIER=0
if [ -f "$ENV_FILE" ]; then
  TIER=$(grep -E '^PLANNEN_TIER=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo 0)
fi
TIER=${TIER:-0}

TABLES=(
  auth.users
  plannen.users
  plannen.app_allowed_emails
  plannen.events
  plannen.event_rsvps
  plannen.event_invites
  plannen.event_memories
  plannen.event_shared_with_users
  plannen.event_shared_with_groups
  plannen.event_sources
  plannen.event_source_refs
  plannen.relationships
  plannen.friend_groups
  plannen.friend_group_members
  plannen.user_profiles
  plannen.user_locations
  plannen.user_oauth_tokens
  plannen.family_members
  plannen.agent_tasks
  plannen.profile_facts
  plannen.stories
  plannen.story_events
)
TABLE_ARGS=()
for t in "${TABLES[@]}"; do TABLE_ARGS+=("--table=$t"); done

if [ "$TIER" = "0" ]; then
  echo "Tier 0 — exporting embedded Postgres to $SQL_OUT ..."
  # Use the Node dumper. pg_dump 16 (Homebrew) can't talk to embedded pg 18+;
  # the Node version uses the same `pg` driver as the rest of the stack so
  # there's no client/server version mismatch.
  DATABASE_URL="postgres://plannen:plannen@127.0.0.1:54322/plannen" \
    node "$ROOT/scripts/lib/dump-tables.mjs" > "$SQL_OUT"
  echo "Done. $(wc -l < "$SQL_OUT") SQL lines written."

  PHOTOS_ROOT="${PLANNEN_PHOTOS_ROOT:-$HOME/.plannen/photos}"
  if [ -d "$PHOTOS_ROOT" ] && [ -n "$(ls -A "$PHOTOS_ROOT" 2>/dev/null || true)" ]; then
    echo "Exporting photos from $PHOTOS_ROOT to $PHOTOS_OUT ..."
    tar czf "$PHOTOS_OUT" -C "$PHOTOS_ROOT" .
    echo "Done. $(du -sh "$PHOTOS_OUT" | cut -f1) photo archive written."
  else
    echo "No photos found under $PHOTOS_ROOT (skipped)."
    rm -f "$PHOTOS_OUT"
  fi

  echo ""
  echo "Bootstrap auto-restores supabase/seed.sql on fresh ~/.plannen/pgdata init."
  echo "Manual restore: node scripts/lib/restore-seed.mjs $SQL_OUT"
  if [ -f "$PHOTOS_OUT" ]; then
    echo "Manual photo restore: node scripts/lib/restore-photos.mjs $PHOTOS_OUT"
  fi
else
  DB_CONTAINER="supabase_db_plannen"
  STORAGE_CONTAINER="supabase_storage_plannen"

  echo "Tier 1 — exporting local Supabase to $SQL_OUT ..."
  {
    echo "-- Local DB export (Tier 1) $(date -u +%Y-%m-%d)"
    echo "-- Restore (Tier 1): supabase db reset (auto-loads this file)"
    echo ""
    echo "SET session_replication_role = replica;"
    echo ""
    # pg_dump 17+ emits psql meta-commands `\restrict <hash>` and
    # `\unrestrict <hash>` at the file boundaries. psql handles these natively,
    # but supabase CLI's seed loader (used by `supabase db reset`) feeds the
    # file through a plain SQL parser that errors with "syntax error at or
    # near \". Strip them so the dump round-trips through both loaders.
    docker exec "$DB_CONTAINER" pg_dump -U postgres \
      --data-only --column-inserts \
      "${TABLE_ARGS[@]}" \
      postgres \
      | grep -vE '^\\(restrict|unrestrict)([[:space:]]|$)'
    echo ""
    echo "SET session_replication_role = DEFAULT;"
  } > "$SQL_OUT"

  echo "Done. $(wc -l < "$SQL_OUT") SQL lines written."

  echo "Exporting storage bucket from $STORAGE_CONTAINER to $PHOTOS_OUT ..."
  docker exec "$STORAGE_CONTAINER" tar czf - -C /mnt . > "$PHOTOS_OUT"
  echo "Done. $(du -sh "$PHOTOS_OUT" | cut -f1) photo archive written."
  echo ""
  echo "supabase db reset will restore the SQL snapshot automatically."
  echo "To restore photos after a reset:"
  echo "  bash scripts/restore-photos.sh"
fi
