-- Optional precise clock time (HH:MM, 24h) for a routine. NULL = use
-- preferred_time_of_day only. Forward-only, additive.
alter table plannen.practices
  add column precise_time text;

alter table plannen.practices
  add constraint practices_precise_time_chk
    check (precise_time is null or precise_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
