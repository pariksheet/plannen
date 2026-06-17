-- Retire the legacy per-event share junctions. They were backfilled into
-- event_shares by 20260617150000 and have had no readers since that migration
-- repointed the RLS helpers; the last app-code reader (MyGroups' per-group
-- filter) now reads event_shares too. Forward-only.
--
-- NOTE: events.shared_with_friends is intentionally KEPT for now — it is still
-- written by both MCP servers' inserts and referenced by event_rsvps /
-- event_memories RLS. Retiring that column is a separate, coordinated change
-- (rewrite those two policies + stop writing the column in every runtime).

DROP TABLE IF EXISTS plannen.event_shared_with_groups;
DROP TABLE IF EXISTS plannen.event_shared_with_users;
