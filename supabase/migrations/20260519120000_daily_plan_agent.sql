-- Daily plan agent: practices, practice_completions, daily_briefings.
-- Forward-only additive migration. All tables live in plannen.* schema and
-- are RLS-scoped to auth.uid().

create table plannen.practices (
  id              uuid primary key default extensions.uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  name            text not null,
  category        text not null
                    check (category in ('health','household','circle','focus','other')),
  frequency_type  text not null
                    check (frequency_type in ('daily','weekly_count','specific_days')),
  target_count    integer
                    check (target_count is null or target_count between 1 and 7),
  days_of_week    text[]
                    check (days_of_week is null or days_of_week <@ array['mon','tue','wed','thu','fri','sat','sun']::text[]),
  preferred_time_of_day text not null default 'anytime'
                    check (preferred_time_of_day in ('morning','afternoon','evening','anytime')),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index practices_user_active on plannen.practices(user_id) where active;

alter table plannen.practices enable row level security;
create policy "practices: owner only" on plannen.practices
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table plannen.practice_completions (
  id              uuid primary key default extensions.uuid_generate_v4(),
  practice_id     uuid not null references plannen.practices(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references plannen.family_members(id) on delete set null,
  completed_on    date not null,
  created_at      timestamptz not null default now()
);

create index practice_completions_practice_date
  on plannen.practice_completions(practice_id, completed_on desc);

create unique index practice_completions_uniq_member
  on plannen.practice_completions (practice_id, completed_on, family_member_id)
  where family_member_id is not null;

create unique index practice_completions_uniq_self
  on plannen.practice_completions (practice_id, completed_on)
  where family_member_id is null;

create index practice_completions_user on plannen.practice_completions(user_id);

alter table plannen.practice_completions enable row level security;
create policy "practice_completions: owner only" on plannen.practice_completions
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table plannen.daily_briefings (
  id              uuid primary key default extensions.uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  briefing_date   date not null,
  content_md      text not null,
  summary         text,
  source          text not null
                    check (source in ('claude_code','claude_desktop','web','cron')),
  generated_at    timestamptz not null default now(),
  unique (user_id, briefing_date)
);

create index daily_briefings_user_date on plannen.daily_briefings(user_id, briefing_date desc);

alter table plannen.daily_briefings enable row level security;
create policy "daily_briefings: owner only" on plannen.daily_briefings
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at touch trigger for practices (reuses existing helper if present).
create or replace function plannen.touch_practices_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger practices_touch_updated_at
  before update on plannen.practices
  for each row execute function plannen.touch_practices_updated_at();

grant all on table plannen.practices            to anon, authenticated, service_role;
grant all on table plannen.practice_completions to anon, authenticated, service_role;
grant all on table plannen.daily_briefings      to anon, authenticated, service_role;
grant all on function plannen.touch_practices_updated_at() to anon, authenticated, service_role;
