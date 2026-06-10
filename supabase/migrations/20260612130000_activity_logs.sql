-- Activity logs: generic "what I did / measured" journal entries (Phase 2 of /log).
-- Forward-only additive migration. RLS-scoped to auth.uid(), mirroring
-- plannen.practices. The `activity` label is free-form (never an enum) — sleep is
-- not special; "sleep"/"run"/"water"/"weight"/"mood" are all just strings. A row
-- carries a duration OR a quantity+unit (or neither).

create table plannen.activity_logs (
  id               uuid primary key default extensions.uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  activity         text not null,
  occurred_at      timestamptz not null default now(),
  duration_minutes integer
                     check (duration_minutes is null or duration_minutes >= 0),
  quantity         numeric,
  unit             text,
  notes            text,
  tags             text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index activity_logs_user_occurred on plannen.activity_logs(user_id, occurred_at desc);
create index activity_logs_user_activity on plannen.activity_logs(user_id, lower(activity));

alter table plannen.activity_logs enable row level security;
create policy "activity_logs: owner only" on plannen.activity_logs
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger activity_logs_touch_updated_at
  before update on plannen.activity_logs
  for each row execute function plannen.touch_practices_updated_at();

grant all on table plannen.activity_logs to anon, authenticated, service_role;
