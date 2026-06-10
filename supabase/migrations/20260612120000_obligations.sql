-- Derived obligations (Phase 3 of unified scheduling).
-- A drop/pick task linked to an attendance: it projects onto the attendance's
-- surviving (post-suppression, override-resolved) instance at read time.
-- Forward-only, additive. RLS owner-only. Reuses plannen.touch_practices_updated_at().

create table plannen.obligations (
  id                         uuid primary key default extensions.uuid_generate_v4(),
  user_id                    uuid not null references auth.users(id) on delete cascade,
  derived_from_attendance_id uuid not null references plannen.attendances(id) on delete cascade,
  role                       text not null check (role in ('drop','pick')),
  anchor                     text not null check (anchor in ('start','end')),
  offset_minutes             integer not null default 0,   -- signed; drop = negative-from-start, pick = 0-from-end
  location_id                uuid references plannen.user_locations(id) on delete set null, -- NULL => inherit attendance's
  active                     boolean not null default true,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index obligations_attendance   on plannen.obligations(derived_from_attendance_id) where active;
create index obligations_user_active  on plannen.obligations(user_id) where active;

alter table plannen.obligations enable row level security;
create policy "obligations: owner only" on plannen.obligations
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger obligations_touch_updated_at
  before update on plannen.obligations
  for each row execute function plannen.touch_practices_updated_at();

grant all on table plannen.obligations to anon, authenticated, service_role;
