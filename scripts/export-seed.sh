#!/usr/bin/env bash
# Export current local DB + event-photos storage bucket.
#
#   supabase/seed.sql           — DB rows for restore (auto-loaded by reset)
#   supabase/seed-photos.tar.gz — storage bucket files (extract manually)
#
# Run this before any `supabase db reset` to preserve your local data.
# After reset, DB is restored automatically; restore photos with:
#   bash scripts/restore-photos.sh
# (Bare `tar xzf` is not enough — see scripts/restore-photos.sh for why.)

set -euo pipefail

DB_CONTAINER="supabase_db_plannen"
STORAGE_CONTAINER="supabase_storage_plannen"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL_OUT="$ROOT/supabase/seed.sql"
PHOTOS_OUT="$ROOT/supabase/seed-photos.tar.gz"

echo "Exporting local DB to $SQL_OUT ..."

{
  echo "-- Local DB export $(date -u +%Y-%m-%d)"
  echo "-- Restore: psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f supabase/seed.sql"
  echo ""
  echo "SET session_replication_role = replica;"
  echo ""
  # pg_dump 17+ emits psql meta-commands `\restrict <hash>` and
  # `\unrestrict <hash>` at the file boundaries. psql handles these natively,
  # but supabase CLI's seed loader (used by `supabase db reset`) feeds the
  # file through a plain SQL parser that errors with "syntax error at or
  # near \". Strip them so the dump round-trips through both loaders.
  docker exec "$DB_CONTAINER" pg_dump -U postgres \
    --data-only \
    --column-inserts \
    --table=auth.users \
    --table=public.users \
    --table=public.app_allowed_emails \
    --table=public.events \
    --table=public.event_rsvps \
    --table=public.event_invites \
    --table=public.event_memories \
    --table=public.event_shared_with_users \
    --table=public.event_shared_with_groups \
    --table=public.event_sources \
    --table=public.event_source_refs \
    --table=public.relationships \
    --table=public.friend_groups \
    --table=public.friend_group_members \
    --table=public.user_profiles \
    --table=public.user_locations \
    --table=public.user_oauth_tokens \
    --table=public.family_members \
    --table=public.agent_tasks \
    --table=public.profile_facts \
    --table=public.stories \
    --table=public.story_events \
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
