-- Trip containers: a container event groups child events + todos under one
-- umbrella (a "Trip"). The container is itself an events row
-- (event_kind='container'); children point at it via group_id.
-- Forward-only; no backfill (no containers exist yet).

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_event_kind_check";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_event_kind_check"
  CHECK (("event_kind" = ANY (ARRAY['event'::"text", 'reminder'::"text", 'session'::"text", 'todo'::"text", 'container'::"text"])));

ALTER TABLE "plannen"."events"
  ADD COLUMN IF NOT EXISTS "group_id" "uuid"
  REFERENCES "plannen"."events"("id") ON DELETE SET NULL;
ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "list_label" "text";

CREATE INDEX IF NOT EXISTS "idx_events_group_id" ON "plannen"."events" ("group_id");

COMMENT ON COLUMN "plannen"."events"."group_id" IS 'For child events/todos: the container (event_kind=container) they belong to. ON DELETE SET NULL — deleting a container detaches children, never destroys them. Orthogonal to parent_event_id (which is recurrence-session-only). A container''s own group_id must be NULL (no nested trips).';
COMMENT ON COLUMN "plannen"."events"."list_label" IS 'For event_kind=todo inside a container: the named list bucket (e.g. Packing / To-do / Shopping). Free-text. NULL/unused otherwise.';
