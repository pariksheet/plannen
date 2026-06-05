# Daily Plan Agent — Design

**Date:** 2026-05-19
**Branch:** `feat/daily_routine_agent`
**Status:** Draft, awaiting user review

## Vocabulary

This spec introduces two product-facing terms:

- **Practice** — a recurring frequency-flex intention (daily or N-times/week). Replaces the productivity-app cliché "habit." Works for solo things (vitamin D) and shared things (Sunday game night). Carries no discipline/streak baggage.
- **Circle** — the people in the user's life: partner, kids, parents, close friends, anyone they plan around. Replaces the narrower "family" framing. The product is not assumed to be nuclear-family-only.

**Scope of rename:** new code, new tables, new MCP tools, new UI strings only. The existing `family_members` table and `family_member_id` columns keep their names — the data already supports any relationship type, and renaming the table is a Plannen-wide refactor that doesn't belong in this spec. A separate later spec can do the table rename if it earns the cost.

## One-line summary

A circle-aware daily plan (briefing + practice checklist) that Claude composes each morning from Plannen's existing events plus a new lightweight practices model, surfaced on a new `/today` route that becomes the default landing.

## Problem

Existing Plannen knows your circle's events (recurring drop-off, kids' activities, watched signups, school holidays). It does not know **frequency-flexible practices** — gym 3×/week, dishes 2×/week, daily vitamin D — and it has no surface that says "here is your day, circle-aware, in one place." Calendars list events; nothing combines events + practice pending-counts + circle context into one morning artifact.

## Wedge

**Circle-awareness is the wedge.** This is not a goals/habits coach competing with Things, Sunsama, Habitica. The value is: *the day plan starts with your circle's schedule — your kids' events, your partner's overlapping commitments, school-holiday context, the friend you promised to call back — because Plannen already knows all of it.* A solo-marathon planner would not earn its place here.

## MVP scope

In:

- **Practices data model** (new `practices` + `practice_completions` tables).
- **Briefing persistence** (new `daily_briefings` table).
- **MCP tools** for practice CRUD, completion logging, briefing context bundle, briefing save/get.
- **Plugin skill + slash command** (`/plannen-today`) telling Claude how to compose the briefing.
- **Web UI:** dedicated `/today` route that **replaces MyFeed as the default landing surface**. Renders the structured briefing + practice checkboxes.

Explicitly out (deferred):

- Goals (marathon, 1000km cycling) — express as practices initially, real goal model only if needed later.
- Intelligent scheduling (LLM proposing time slots for practices).
- Push channels (email / WhatsApp / printer / PDF).
- Cron-scheduled briefing generation.
- Multi-member views (each member of the circle sees their own plan).
- Streak / insights UI.
- Practice-definition web form (v1.5 — practices are defined via Claude chat in v1).

## Architecture

### Data model

Forward-only additive migration under `supabase/migrations/`:

```sql
create table practices (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  family_member_id uuid references family_members(id) on delete set null,
  name            text not null,
  category        text not null check (category in
                    ('health','household','circle','focus','other')),
  frequency_type  text not null check (frequency_type in
                    ('daily','weekly_count','specific_days')),
  target_count    integer,           -- used when frequency_type='weekly_count'
  days_of_week    text[],            -- used when frequency_type='specific_days'
                                     -- values: mon|tue|wed|thu|fri|sat|sun
  preferred_time_of_day text not null default 'anytime'
                    check (preferred_time_of_day in
                      ('morning','afternoon','evening','anytime')),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index practices_owner_active on practices(owner_user_id) where active;

create table practice_completions (
  id              uuid primary key default gen_random_uuid(),
  practice_id     uuid not null references practices(id) on delete cascade,
  family_member_id uuid references family_members(id) on delete set null,
  completed_on    date not null,
  created_at      timestamptz not null default now(),
  unique (practice_id, completed_on, family_member_id)
);

create index practice_completions_practice_date on practice_completions(practice_id, completed_on desc);

create table daily_briefings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  briefing_date   date not null,
  content_md      text not null,
  summary         text,
  source          text not null check (source in
                    ('claude_code','claude_desktop','web','cron')),
  generated_at    timestamptz not null default now(),
  unique (user_id, briefing_date)         -- regenerate overwrites
);

create index daily_briefings_user_date on daily_briefings(user_id, briefing_date desc);
```

RLS: all three tables `owner_user_id`/`user_id` scoped to `auth.uid()`.

Note: the `practices.category` enum includes `'circle'` (for circle-related practices like "call mum weekly", "date night") rather than `'family'`, in keeping with the new vocabulary.

Fixed-time recurrences (vitamin D every 08:00, school drop Mon–Fri 08:15) stay in `events` as recurring events (`event_kind='reminder'`, existing `recurrence_rule`). The practices table is only for frequency-flex things.

### MCP tools (added in `mcp/src/index.ts`)

Reads:

- `list_practices({ active_only?, family_member_id? })` → practices list.
- `get_briefing_context({ date? })` → composite snapshot for that date (see below).
- `get_daily_briefing({ date? })` → latest persisted briefing for date.

Writes:

- `create_practice({ name, category, frequency_type, target_count?, days_of_week?, preferred_time_of_day?, family_member_id? })`
- `update_practice({ id, ...fields })`
- `delete_practice({ id })` (soft delete: sets `active=false`).
- `mark_practice_done({ practice_id, completed_on?, family_member_id? })` — idempotent (unique constraint).
- `unmark_practice_done({ practice_id, completed_on?, family_member_id? })` — for undo.
- `save_daily_briefing({ briefing_date, content_md, summary?, source })` — upserts on `(user_id, briefing_date)`.

`get_briefing_context(date)` returns one bundled object so Claude does one MCP round-trip:

```ts
{
  date: "2026-05-20",
  weekday: "Wednesday",
  user: { id, display_name, locale, timezone },
  circle: [...],                 // existing family_members rows, surfaced as
                                 // "your circle" in product copy; includes goals[]
  events_today: [...],           // events for that date, recurrence resolved,
                                 // including event_kind='reminder' (fixed-time intents)
  events_tomorrow: [...],        // light preview for "tomorrow has X"
  recent_past_events: [...],     // last 7 days, for "yesterday you went to..."
  practices_due_today: [
    { id, name, category, frequency_type, target_count?,
      completions_this_week, remaining_this_week,
      preferred_time_of_day, family_member_id }
  ],
  historical_facts: [...],       // any facts flagged for today
                                 // (school holiday, public holiday, etc.)
  locations: [...]               // for travel-time context
}
```

The `circle` key is named for product copy; underneath it's the existing `family_members` table (no schema rename in this spec). The MCP tool descriptions and the briefing prompt use "circle" throughout.

**Decision:** no `generate_briefing` MCP tool. Claude *writes* the briefing; tools are its hands.

### Plugin (the brain)

`plugin/skills/plannen-day-plan.md` — always-on skill loaded whenever the conversation references today / morning / day plan / "what's on" / `/plannen-today`. Instructs Claude to:

1. Call `get_briefing_context(today)`.
2. Compose a **structured (non-prose) briefing** following the format spec below.
3. Call `save_daily_briefing(...)` with `source` matching the invocation surface.
4. If the user mentions practice completions in the same turn, call `mark_practice_done`.

`plugin/commands/plannen-today.md` — `/plannen-today` slash command, explicit trigger.

### Briefing format

**Structured time-block sketch, no prose paragraphs.** Markdown. Reference shape:

```markdown
# Tuesday, 20 May

## Schedule
- 08:00 — Vitamin D
- 08:15 — Drop Aarav at school
- 09:30 — Standup
- 14:00 — Aarav: dentist (you driving)
- 17:00 — Maya: piano pickup
- 19:00 — Family dinner

## Practices today
- [ ] Gym (2/3 this week)
- [ ] Dishes (1/2 this week)
- [ ] 30min reading (daily)

## Circle
- School holiday Thu–Mon
- Partner away Fri evening → Sun
- Call mum (overdue — last call 9 days ago)
```

Rules: bullets only, max ~30 lines, no motivational copy, no narrative paragraphs. Any section omitted if empty.

### Web UI

New route: `/today` — becomes the **default landing surface** (replaces MyFeed as the index route). MyFeed stays accessible via top-level navigation but is no longer the default.

`/today` renders:

- The latest `daily_briefings` row for today (markdown rendered).
- The practice checkboxes from `practices_due_today`, each one a live toggle calling `mark_practice_done` / `unmark_practice_done`. Checked state syncs from `practice_completions` for today's date.
- A "Regenerate" button — v1: shows instructions to ask Claude (`/plannen-today` in your Claude client). v1.5: an inline call to a web-side generator (deferred).
- An empty state: "No briefing for today yet. Ask Claude: `/plannen-today`."

No web-side AI calls in v1. Generation happens only in a Claude client (Code or Desktop).

### Lazy generation flow

```
User in Claude Code / Desktop:
  /plannen-today
↓
Claude (plannen-day-plan skill):
  get_briefing_context(today)
  -> composes structured briefing
  save_daily_briefing(today, md, source='claude_code'|'claude_desktop')
↓
User opens web app, lands on /today:
  GET /today → get_daily_briefing(today) → render
  Checkbox interactions → mark_practice_done / unmark_practice_done
```

## Migration plan

1. **Schema migration:** single forward-only file `supabase/migrations/<ts>_daily_plan_agent.sql` with the three new tables, RLS policies, indexes. Tier 0 picks it up via `scripts/lib/migrate.mjs`; Tier 1 via `supabase migration up`. **No backfill needed** — feature ships empty.
2. **MCP tools:** add to `mcp/src/index.ts` with `withUserContext` for RLS.
3. **Plugin:** add `plannen-day-plan.md` skill and `plannen-today.md` command under `plugin/`.
4. **Web UI:** add `/today` route, demote MyFeed from default-landing in the router. Component pulls briefing + practices via MCP-backed API.
5. **Tests** (see below).

## Testing

Per `superpowers:test-driven-development`:

- **MCP tools:** unit tests for each new tool. RLS round-trip tests (user A cannot read user B's practices/briefings).
- **`get_briefing_context`:** snapshot tests for representative fixtures (school holiday day, partner-away day, all-empty day, practice-frequency edge cases — 0/N, 3/3 done, weekly carry-over).
- **Practice completion idempotency:** marking same practice twice on same date is a no-op.
- **`save_daily_briefing` upsert:** second save on same `(user_id, date)` overwrites.
- **Web `/today`:** route renders briefing markdown, checkbox toggles persist, empty state shows on missing briefing.
- **Plugin skill:** behavioral test against a seeded DB asserting a `/plannen-today` invocation produces a `daily_briefings` row with the expected structural sections. (Test harness: whichever Claude provider is wired by the time we implement — the `claude -p` Tier 0 provider spec lands in a separate session, so this test slot may be a manual fixture in v1 if the harness isn't ready.)

## Open questions / defaults

These are explicit defaults the user can override during spec review:

1. **Briefing length cap:** ~30 lines / no prose paragraphs. Hard cap in the skill prompt.
2. **Practice "weekly" rollover:** week boundary = Monday 00:00 local. Completions counted within current week.
3. **Multi-completion same-day:** the unique constraint allows one completion per `(practice, date, family_member)`. Marking twice is idempotent. A "did gym twice today" need is out of scope.
4. **Empty briefing days:** if `get_briefing_context` returns zero events and zero due practices, `/plannen-today` should produce a one-line briefing ("Quiet day, no practices due."), not refuse to generate.
5. **Timezone:** all dates resolved in the user's local timezone (read from profile if set, else from browser/system). UTC nowhere user-facing. If the profile schema does not yet carry a timezone column, add it in this migration.
6. **Source attribution:** `source` in `daily_briefings` lets us later tell apart briefings written by different clients (useful when v2 adds cron-generated ones).

## Out of scope / named follow-up slices

- **Slice B (channels):** email / WhatsApp / PDF / printer delivery of today's briefing.
- **Slice C (cron):** scheduled morning generation per user (Tier 0: local cron + `claude -p` subprocess; Tier 1/2: edge function / Node backend).
- **Slice D (scheduling):** LLM proposes time-slots for practices inside the briefing.
- **Slice E (goals):** structured goal model with target dates and progress aggregation across practices.
- **Slice F (insights):** streaks, completion rates, practice history view.
- **Slice G (web practice form):** UI to create/edit practices without Claude chat.
- **Slice H (`family_members` table rename):** if/when the broader `family_members` → `circle_members` (or similar) rename earns its blast radius cost, do it as its own spec.

Each is a separate brainstorm → spec cycle later.
