-- Unified recurrence on practices (Phase 1).
-- Replaces frequency_type/target_count/days_of_week with a recurrence model:
--   recurrence_mode = 'pinned'      -> recurrence_rule (jsonb, RecurrenceRule shape)
--   recurrence_mode = 'flex_count'  -> flex_period + flex_target
-- Forward-only. Safe drop: zero practice rows exist at migration time (verified).

alter table plannen.practices
  add column recurrence_mode  text,
  add column recurrence_rule  jsonb,
  add column dtstart          date not null default current_date,
  add column recurrence_until date,
  add column flex_period      text,
  add column flex_target      integer;

-- No rows to backfill. Set a default mode so the NOT NULL below holds even if a
-- stray row appears between add and constraint.
update plannen.practices set recurrence_mode = 'flex_count', flex_period = 'week', flex_target = 1
  where recurrence_mode is null;

alter table plannen.practices
  alter column recurrence_mode set not null,
  drop column frequency_type,
  drop column target_count,
  drop column days_of_week;

alter table plannen.practices
  add constraint practices_recurrence_mode_chk
    check (recurrence_mode in ('pinned','flex_count')),
  add constraint practices_flex_period_chk
    check (flex_period is null or flex_period in ('week','month')),
  add constraint practices_flex_target_chk
    check (flex_target is null or flex_target between 1 and 31),
  add constraint practices_recurrence_shape_chk
    check (
      (recurrence_mode = 'pinned'
        and recurrence_rule is not null
        and flex_period is null and flex_target is null)
      or
      (recurrence_mode = 'flex_count'
        and flex_period is not null and flex_target is not null
        and recurrence_rule is null)
    );
