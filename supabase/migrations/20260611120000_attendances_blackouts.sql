-- Attendances + blackout calendars + suppression (Phase 2 of unified scheduling).
-- Attendances reuse the pinned-recurrence JSONB shape (recurrence_rule) from practices.
-- Indicative: never fed to the conflict checker (like reminder events).
-- Forward-only, additive. RLS owner-only. Reuses plannen.touch_practices_updated_at().

create table plannen.attendances (
  id               uuid primary key default extensions.uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid not null references plannen.family_members(id) on delete cascade,
  name             text not null,
  location_id      uuid references plannen.user_locations(id) on delete set null,
  recurrence_rule  jsonb not null,               -- always pinned: {frequency,interval,days}
  dtstart          date not null default current_date,
  recurrence_until date,                          -- NULL = open-ended (term); NOT NULL = bounded (camp)
  time_of_day      text,                           -- optional HH:MM (informational)
  start_time       text,                           -- HH:MM
  end_time         text,                           -- HH:MM
  priority         smallint not null default 0,    -- bounded enrolments seed higher
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index attendances_member_active on plannen.attendances(family_member_id) where active;
create index attendances_user_active   on plannen.attendances(user_id) where active;

create table plannen.blackout_calendars (
  id               uuid primary key default extensions.uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  name             text not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index blackout_calendars_user_active on plannen.blackout_calendars(user_id) where active;

create table plannen.blackout_windows (
  id          uuid primary key default extensions.uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  calendar_id uuid not null references plannen.blackout_calendars(id) on delete cascade,
  starts_on   date not null,
  ends_on     date not null,                       -- inclusive
  label       text,
  created_at  timestamptz not null default now()
);
create index blackout_windows_cal_start on plannen.blackout_windows(calendar_id, starts_on);

create table plannen.attendance_blackouts (
  attendance_id uuid not null references plannen.attendances(id) on delete cascade,
  calendar_id   uuid not null references plannen.blackout_calendars(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (attendance_id, calendar_id)
);
create index attendance_blackouts_cal on plannen.attendance_blackouts(calendar_id);

-- RLS owner-only for all four tables.
alter table plannen.attendances          enable row level security;
alter table plannen.blackout_calendars   enable row level security;
alter table plannen.blackout_windows     enable row level security;
alter table plannen.attendance_blackouts enable row level security;

create policy "attendances: owner only" on plannen.attendances
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "blackout_calendars: owner only" on plannen.blackout_calendars
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "blackout_windows: owner only" on plannen.blackout_windows
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "attendance_blackouts: owner only" on plannen.attendance_blackouts
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at touch triggers (reuse the existing generic helper).
create trigger attendances_touch_updated_at
  before update on plannen.attendances
  for each row execute function plannen.touch_practices_updated_at();
create trigger blackout_calendars_touch_updated_at
  before update on plannen.blackout_calendars
  for each row execute function plannen.touch_practices_updated_at();

grant all on table plannen.attendances          to anon, authenticated, service_role;
grant all on table plannen.blackout_calendars   to anon, authenticated, service_role;
grant all on table plannen.blackout_windows     to anon, authenticated, service_role;
grant all on table plannen.attendance_blackouts to anon, authenticated, service_role;
