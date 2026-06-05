-- Storage adapter prep: canonical key column on event_memories.
-- Forward-only additive migration. storage_key is the backend-agnostic
-- identifier; media_url stays as a cached publicUrl for backward compat.
--
-- Key shape: <user_id>/<event_id>/<uuid>.<ext> with NO bucket prefix.

ALTER TABLE plannen.event_memories
  ADD COLUMN IF NOT EXISTS storage_key text;

COMMENT ON COLUMN plannen.event_memories.storage_key IS
  'Backend-agnostic object key under the event-photos bucket. Shape: <user_id>/<event_id>/<uuid>.<ext>. NULL for legacy rows that pre-date the storage adapter; resolve those via media_url.';

-- Backfill: strip the publicUrl prefix to recover the key.
-- Handles both Tier 0 (/storage/v1/object/public/event-photos/<key>) and
-- Tier 1/2 (<SUPABASE_URL>/storage/v1/object/public/event-photos/<key>).
UPDATE plannen.event_memories
SET storage_key = substring(media_url FROM '/storage/v1/object/public/event-photos/(.*)$')
WHERE storage_key IS NULL
  AND media_url IS NOT NULL
  AND media_url LIKE '%/storage/v1/object/public/event-photos/%';

CREATE INDEX IF NOT EXISTS event_memories_storage_key_idx
  ON plannen.event_memories (storage_key)
  WHERE storage_key IS NOT NULL;
