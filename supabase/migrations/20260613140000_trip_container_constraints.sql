-- Trip-container integrity constraints (defense-in-depth at the DB layer, so the
-- invariants hold on every write path — MCP, direct SQL, dashboard — not just the
-- app-layer guards in the MCP handlers).
--
-- 1. A container cannot itself belong to another container (no nested trips).
-- 2. list_label is meaningful only for todos inside a container.
-- Both hold for all existing rows (no containers exist yet; list_label was just
-- added and is NULL everywhere), so these are safe to add forward-only.

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_no_nested_containers";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_no_nested_containers"
  CHECK (NOT ("event_kind" = 'container' AND "group_id" IS NOT NULL));

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_list_label_todo_only";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_list_label_todo_only"
  CHECK ("list_label" IS NULL OR "event_kind" = 'todo');
