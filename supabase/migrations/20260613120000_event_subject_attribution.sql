-- Event subject attribution: an event can represent someone else's busy time.
-- subject_kind/subject_id is a polymorphic pointer (no FK, app-resolved, same
-- convention as events.assigned_to): NULL = the owner's own event; otherwise the
-- referenced person is the busy one. owner_attends = the owner also occupies this
-- time (so it still clashes). See
-- docs/superpowers/specs/2026-06-12-event-family-attribution-design.md
alter table plannen.events
  add column subject_kind  text
    check (subject_kind in ('family_member', 'user')),
  add column subject_id    uuid,
  add column owner_attends boolean not null default false;

-- subject_kind and subject_id are set together or not at all.
alter table plannen.events
  add constraint events_subject_pair
    check ((subject_kind is null) = (subject_id is null));
