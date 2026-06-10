-- To-do event type: a dated, checkable, one-off task.
-- Adds `todo` to the event_kind enum, plus completion + assignment columns.
-- Forward-only; no data backfill needed (no todos exist yet).

ALTER TABLE "plannen"."events" DROP CONSTRAINT IF EXISTS "events_event_kind_check";
ALTER TABLE "plannen"."events"
  ADD CONSTRAINT "events_event_kind_check"
  CHECK (("event_kind" = ANY (ARRAY['event'::"text", 'reminder'::"text", 'session'::"text", 'todo'::"text"])));

ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "plannen"."events" ADD COLUMN IF NOT EXISTS "assigned_to" "uuid";

COMMENT ON COLUMN "plannen"."events"."event_kind" IS 'event = full event (URL, RSVP, watch); reminder = simple appointment/reminder; todo = checkable one-off task (completed_at tracks done-state); session = generated child of a recurring event';
COMMENT ON COLUMN "plannen"."events"."completed_at" IS 'For event_kind=todo: timestamp the task was checked off; NULL = open. Unused for other kinds.';
COMMENT ON COLUMN "plannen"."events"."assigned_to" IS 'For event_kind=todo: user the task is assigned to. Phase 1 always equals created_by; no FK so it can later point at a user or family member.';
