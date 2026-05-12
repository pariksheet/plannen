#!/usr/bin/env bash
# Restore photos from supabase/seed-photos.tar.gz.
#
# `supabase db reset` clears storage.objects, and `tar czf` (used by
# export-seed.sh) does not preserve the user.supabase.{cache-control,
# content-type,etag} xattrs that the storage worker reads. So a naive
# extract leaves files on disk that the API can't serve (404 if the
# storage.objects row is missing, 500 ENODATA if the xattrs are missing).
#
# This script:
#   1. Extracts seed-photos.tar.gz into the storage container's /mnt.
#   2. Sets the 3 xattrs storage v1.x reads, on every file under each bucket.
#   3. Inserts one storage.objects row per file (idempotent — ON CONFLICT skips).
#
# Idempotent: safe to re-run after every reset.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$ROOT/supabase/seed-photos.tar.gz"
STORAGE_CONTAINER="${PLANNEN_STORAGE_CONTAINER:-supabase_storage_plannen}"
DB_HOST="${PLANNEN_DB_HOST:-127.0.0.1}"
DB_PORT="${PLANNEN_DB_PORT:-54322}"
DB_USER="${PLANNEN_DB_USER:-postgres}"
DB_PASS="${PLANNEN_DB_PASS:-postgres}"
DB_NAME="${PLANNEN_DB_NAME:-postgres}"

if [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: $ARCHIVE not found. Run scripts/export-seed.sh on a working machine first." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${STORAGE_CONTAINER}$"; then
  echo "ERROR: container $STORAGE_CONTAINER not running. Start with: bash scripts/local-start.sh" >&2
  exit 1
fi

echo "→ Ensuring 'attr' is installed in $STORAGE_CONTAINER (for setfattr)…"
docker exec "$STORAGE_CONTAINER" sh -c 'command -v setfattr >/dev/null 2>&1 || apk add --no-cache attr >/dev/null 2>&1'

echo "→ Extracting $ARCHIVE into $STORAGE_CONTAINER:/mnt…"
docker exec -i "$STORAGE_CONTAINER" tar xzf - -C /mnt < "$ARCHIVE"

echo "→ Reconstructing xattrs and storage.objects rows…"

# Container layout is /mnt/<tenant>/<project>/<bucket>/<name>/<version>.
# Walk every regular file at depth ≥5; emit tab-separated columns matching the
# temp-table schema below. The script runs inside the container so we can
# both setfattr and stat in one pass.
ROWS=$(docker exec "$STORAGE_CONTAINER" sh -c '
  set -e
  cd /mnt
  find . -mindepth 5 -type f | while IFS= read -r path; do
    rel=${path#./}
    tenant=${rel%%/*};   rest=${rel#*/}
    project=${rest%%/*}; rest=${rest#*/}
    bucket=${rest%%/*};  rest=${rest#*/}
    version=${rest##*/}
    name=${rest%/*}
    full=/mnt/$rel
    size=$(stat -c %s "$full")
    etag=$(md5sum "$full" | awk "{print \$1}")
    ext=$(printf %s "$name" | awk -F. "{print tolower(\$NF)}")
    case "$ext" in
      jpg|jpeg)  mime=image/jpeg ;;
      png)       mime=image/png ;;
      gif)       mime=image/gif ;;
      webp)      mime=image/webp ;;
      heic)      mime=image/heic ;;
      heif)      mime=image/heif ;;
      mp4)       mime=video/mp4 ;;
      mov)       mime=video/quicktime ;;
      mp3)       mime=audio/mpeg ;;
      m4a)       mime=audio/mp4 ;;
      wav)       mime=audio/wav ;;
      ogg)       mime=audio/ogg ;;
      flac)      mime=audio/flac ;;
      *)         mime=application/octet-stream ;;
    esac
    setfattr -n user.supabase.content-type  -v "$mime"     "$full"
    setfattr -n user.supabase.cache-control -v "no-cache"  "$full"
    setfattr -n user.supabase.etag          -v "\"$etag\"" "$full"
    # owner is the 2nd segment of the bucket-relative name (event-id/owner-id/…).
    # Empty if the layout differs; storage works without it.
    owner=$(printf %s "$name" | awk -F/ "{print \$2}")
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$bucket" "$name" "$owner" "$version" "$size" "$mime"
  done
')

if [ -z "$ROWS" ]; then
  echo "  (no files found under /mnt — nothing to restore)"
  exit 0
fi

COUNT=$(printf %s "$ROWS" | wc -l | tr -d ' ')
echo "  parsed $COUNT files; upserting storage.objects rows…"

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
CREATE TEMP TABLE _restore_tmp (
  bucket_id text,
  name      text,
  owner_id  text,
  version   text,
  size      bigint,
  mime      text
);

COPY _restore_tmp FROM STDIN WITH (FORMAT text, DELIMITER E'\t');
$ROWS
\.

INSERT INTO storage.objects (bucket_id, name, owner_id, version, metadata)
SELECT bucket_id,
       name,
       NULLIF(owner_id, ''),
       version,
       jsonb_build_object(
         'size', size,
         'mimetype', mime,
         'cacheControl', 'no-cache'
       )
FROM _restore_tmp
ON CONFLICT (bucket_id, name) DO UPDATE
  SET version  = EXCLUDED.version,
      metadata = EXCLUDED.metadata;
SQL

echo "✓ done. Photos should now serve via the storage API."
