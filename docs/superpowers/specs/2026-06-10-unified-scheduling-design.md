# Unified scheduling — recurrence engine, attendances, blackouts & linked obligations — design

**Date:** 2026-06-10
**Status:** Approved (design); pending implementation plan

> All examples below use invented personas ("Milo" = a son at a primary school, "Nora" = a daughter at a creche, "example school" / "example creche"). No real names, schools, addresses, or schedules appear in this spec, the code, or the tests it describes — the repo is public.

## Problem / gap

Plannen has two unrelated recurrence systems:

| System | Recurrence model | Expressiveness | Used by |
|---|---|---|---|
| Events | `recurrence_rule` (iCal RRULE) + materialised `session` rows | Full RRULE | calendar events, course series |
| Practices | `frequency_type` ∈ {`daily`, `weekly_count`, `specific_days`} | 3 fixed shapes | routines (gym, dishes) |

Three concrete gaps fall out:

1. **No "every-N-days" cadence.** "Meal prep every alternate day" cannot be expressed: `daily` is too often, `weekly_count` loses the spacing, `specific_days` drifts and resets weekly.
2. **No contextual suppression.** A recurring "school drop-off 08:15 weekdays" fires on dates when school is closed (summer holiday, term break). The user must hand-maintain exceptions.
3. **No dependency between a person's schedule and the responsible adult's obligations.** "Drop/pick Milo" is conceptually *derived from* Milo attending school — but today it would be an independent recurrence the user maintains by hand, with no awareness that Milo is on summer holiday or at camp instead.

This design unifies the recurrence model and adds two new primitives — **attendances + blackout calendars** and **linked derived obligations** — so a member's schedule and the adult's obligations stay consistent automatically, while creation stays opt-in.

## Core model

### Two recurrence flavors

Every recurring schedulable carries a `recurrence` that is **exactly one** of:

- **Pinned** — an RRULE string + optional time-of-day. Covers every-other-day cadence (`FREQ=DAILY;INTERVAL=2`), weekdays (`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`), monthly, "last Friday", etc. Time-of-day is **optional** — meal prep recurs every 2 days but is cooked whenever.
- **Flex count** — "N completions per period (`week` | `month`), anytime." Covers gym 3×/week, dishes 3×/week. No firing time; rendered as progress, not a slot.

This replaces the practice `frequency_type` 3-way enum. The old shapes map cleanly: `daily` → pinned `FREQ=DAILY`; `weekly_count` → flex-count `week`/N; `specific_days` → pinned `FREQ=WEEKLY;BYDAY=…`.

### Primitives

| Primitive | What it is | Owner | Conflict-checked? |
|---|---|---|---|
| **Practice** | A flex-count or pinned routine with no source link | user or member | flex: no; pinned: yes |
| **Attendance** | A member's recurring enrolment (school, creche, camp) — location + start/end times + pinned recurrence | a family member | indicative only (see below) |
| **Blackout calendar** | A named set of date-range rows ("example school holidays") that suppress linked attendance instances | member or shared | never (indicative) |
| **Derived obligation** | A drop/pick task linked to an attendance via role + offset | the responsible adult | yes (it's an actionable commitment) |

## Decisions

1. **One recurrence representation, shared by events and practices.** A common `recurrence` shape (kind + rrule + flex-count fields + optional time-of-day + start/until) is defined once and reused. Events keep their existing `recurrence_rule`; practices adopt the unified shape.

2. **Practices get a clean-slate rework.** There are currently **zero practice rows** for the user, so the `practices` table is migrated to the unified recurrence with no data backfill. `frequency_type` / `target_count` / `days_of_week` are replaced by `recurrence_kind`, `rrule`, `flex_period`, `flex_target`, `time_of_day`.

3. **Attendances are member-owned schedulables, never auto-actioned.** An attendance records *that a member is somewhere on a schedule*. It never, by itself, creates an obligation for anyone — the member might travel independently, or another adult might cover it.

4. **Blackout calendars are a dedicated table, not an `event_kind`.** They are member-linked, reusable across multiple attendances (a school's holidays suppress both the drop *and* the pick), and hold date ranges rather than single datetimes — a poor fit for the events table. They are **indicative**: excluded from the conflict checker, exactly as `reminder` rows already are.

5. **Derived obligations are opt-in via the intent gate, then stay linked.** When Plannen learns of an attendance with no linked obligation, it *offers once*: "Milo's at the example school Mon–Fri 08:30–15:30 — want me to add a drop (08:15) and pick (16:00), or does he go on his own?" It creates the linked obligation **only on an affirmative**. Once created, the obligation **stays linked** to the attendance: it projects onto the attendance's surviving instances, so it auto-suppresses during blackouts and auto-swaps when a higher-priority attendance overlaps. This mirrors the existing event-creation intent gate in `plannen-core`.

6. **Bounded attendance overrides open-ended for its window.** When two attendances for the same member overlap (open-ended school term vs. a bounded camp week), the **bounded/explicit one wins** for its date window. A linked obligation re-projects onto the winning attendance's times and location. This makes the camp swap correct **even if the user forgets to mark the school holiday**.

7. **Read-time (lazy) expansion — approach A.** Nothing is pre-materialised for the new primitives. Reading a day/week expands every schedulable on the fly → subtracts overlapping blackout windows → resolves member-overlap by rule 6 → projects derived obligations onto surviving instances. Flex-counts render as progress; pinned/derived render as timed items.

8. **The conflict checker is fed, not changed.** Expanded *actionable* instances (excluding indicative attendances/blackouts) are passed to the existing overlap checker. No special-casing is added there; indicative rows are filtered out before the check, consistent with today's `reminder` exclusion.

## Worked example

Personas: **Milo** (son, example school, weekdays, ends 16:00; Wednesdays 12:00), **Nora** (daughter, example creche, weekdays). The user opts into drop/pick for Milo.

**Stored rows (small, stable):**
- Attendance: Milo @ example school — `FREQ=WEEKLY;BYDAY=MO..FR`, end 16:00 (Wed 12:00), blackout calendar = "example school holidays".
- Attendance: Nora @ example creche — weekdays.
- Blackout calendar "example school holidays" — one date-range row: Jul 1 – Aug 31.
- Derived obligation: drop (offset = start − 15m), pick (offset = end), `derived_from` = Milo's school attendance, owner = user.

**Read a normal term week (mid-June):**
- School attendance expands Mon–Fri; no blackout overlap → all survive.
- Drop/pick project: Mon/Tue/Thu/Fri drop 08:15 + pick 16:00; **Wed pick 12:00** (inherited from the source's Wednesday end-time — no separate rule).

**Read the week of a summer camp (e.g. Jul 7–11), with the holiday marked and a camp attendance added:**
- School attendance instances fall inside the "example school holidays" blackout → **suppressed** → their drop/pick **vanish automatically**.
- The bounded **camp** attendance (Jul 7–11, 09:00–16:00, camp location) survives.
- The linked obligation re-projects onto camp → **drop ~08:45 + pick 16:00 at the camp location**.
- The camp block shows on the user's view as **indicative context** ("Milo @ camp") — visible, but it does **not** trip the conflict checker against the user's own meetings.

**Read a holiday week with no camp:** school suppressed, nothing to project → the user's calendar is simply free of drop/pick.

No regeneration, no cleanup: correcting the school end-time once, or adding a camp, instantly reshapes every affected day.

## Data model

Additive, forward-only migrations under `supabase/migrations/` (plus the Tier 0 overlay only if roles/`auth.*`/`storage.*` are touched — they are not here).

### Shared recurrence shape (Phase 1)

Reworks `plannen.practices`:

- `recurrence_kind text NOT NULL CHECK (recurrence_kind IN ('pinned','flex_count'))`
- `rrule text NULL` — required when `pinned`; an RFC 5545 RRULE.
- `flex_period text NULL CHECK (flex_period IN ('week','month'))` — required when `flex_count`.
- `flex_target integer NULL CHECK (flex_target BETWEEN 1 AND 31)` — required when `flex_count`.
- `time_of_day text NULL` — optional `HH:MM` or NULL (= anytime).
- `dtstart date NULL`, `until date NULL` — recurrence range bounds.
- Drop `frequency_type`, `target_count`, `days_of_week`.
- `practice_completions` is unchanged (per-date completion log still applies to both flavors).

A small pure module (`practices.ts` → generalised to `recurrence.ts`, mirrored into `supabase/functions/_shared/`) owns: `expandRrule(rrule, dtstart, until, window)`, `isFlexDueIn(period, target, completions, window)`, `remainingThisPeriod(...)`. Fully unit-tested with synthetic dates passed in (no `Date.now()`).

### Attendances + blackouts (Phase 2)

- `plannen.attendances` — `id`, `user_id`, `family_member_id NOT NULL`, `name`, `location_id NULL`, `recurrence_kind`/`rrule`/`time_of_day`/`dtstart`/`until` (reuse the shared shape; attendances are always `pinned`), `start_time`, `end_time`, `priority smallint NOT NULL DEFAULT 0` (bounded enrolments seed a higher priority), `active`, timestamps. RLS owner-only.
- `plannen.blackout_calendars` — `id`, `user_id`, `family_member_id NULL`, `name`, `active`, timestamps. RLS owner-only.
- `plannen.blackout_windows` — `id`, `calendar_id` (FK, cascade), `starts_on date`, `ends_on date`, `label NULL`. Indexed on `(calendar_id, starts_on)`.
- `plannen.attendance_blackouts` — join table `(attendance_id, calendar_id)`.

Suppression: an attendance instance on date `d` is suppressed iff any linked blackout window covers `d`.

### Derived obligations (Phase 3)

- `plannen.obligations` — `id`, `user_id` (the responsible adult/owner), `derived_from_attendance_id` (FK, cascade), `role text CHECK (role IN ('drop','pick'))`, `offset_minutes integer` (signed; drop = negative from start, pick = 0 from end — `anchor text CHECK (anchor IN ('start','end'))` disambiguates), `location_id NULL` (defaults to the attendance's), `active`, timestamps. RLS owner-only.

Override resolution (rule 6): for a member with multiple active attendances overlapping date `d`, the surviving instance is the one with the highest `priority`, ties broken by the more specific (bounded `until`) recurrence. Obligations project onto that surviving instance.

## MCP tools

Per the dual-implementation parity rule, every tool is added in **both** `mcp/src/index.ts` (Tier 0) and a `ToolModule` under `supabase/functions/mcp/tools/` (Tier 1/2), imported into `supabase/functions/mcp/index.ts`, and covered by `scripts/check-mcp-parity.mjs`.

- **Phase 1** — `create_practice` / `update_practice` / `list_practices` schemas change to the unified recurrence (kind + rrule | flex fields + time_of_day). `mark_practice_done` / `unmark_practice_done` unchanged.
- **Phase 2** — `create_attendance`, `update_attendance`, `list_attendances`, `delete_attendance`; `create_blackout_calendar`, `add_blackout_window`, `list_blackout_calendars`, `link_attendance_blackout`.
- **Phase 3** — `create_obligation`, `update_obligation`, `list_obligations`, `delete_obligation`. `get_briefing_context` is extended to return expanded, blackout-suppressed, override-resolved instances for the requested window.

The agent-facing intent-gate behaviour (offer drop/pick once when an attendance is learned) is documented in the `plannen-core` skill, not in code — consistent with the existing event intent gate.

## UI

- **Phase 1** — the existing "Routines" surfaces (`Today.tsx`, `RoutinesCard` in `ScheduleOverview.tsx`) render flex-count progress (`2/3 this week`) and pinned routines (with their time, or "anytime"). A recurrence picker (kind → RRULE builder or flex N-per-period) is added to the routine create/edit affordance.
- **Phase 2** — attendances render on the member's schedule; blackout windows render as indicative bands (greyed, no conflict marker).
- **Phase 3** — derived obligations render on the adult's calendar as ordinary timed items, tagged with their source ("drop · Milo @ school"); the source attendance shows as indicative context on the adult's view.

## Phasing

- **Phase 1 — unified recurrence on practices.** Standalone; solves dishes, gym, and the alternate-day meal-prep gap. No new primitives.
- **Phase 2 — attendances + blackout calendars + suppression.** Member schedules become first-class and suppressible.
- **Phase 3 — linked derived obligations + intent-gate offer + override resolution.** The drop/pick-follows-the-child story lands here.

Each phase ships independently and is independently testable.

## Testing

- **Recurrence engine** (`recurrence.test.ts`, both runtimes): every-N-days, weekday RRULE, monthly, flex-count due/remaining across week & month boundaries (ISO week, Monday start). Synthetic dates only.
- **Suppression**: attendance instances inside / on the edge of / outside a blackout window.
- **Override**: open-ended term vs. bounded camp overlap → camp wins for its window; obligation re-projects.
- **Conflict feed**: indicative attendances/blackouts excluded; derived obligations included.
- **Parity**: `scripts/check-mcp-parity.mjs` passes for all new tools.
- **No personal data**: all fixtures use invented personas ("Milo", "Nora", "example school"); a grep check in the test setup asserts no real-data patterns.

## Out of scope (YAGNI)

- Assigning obligations to *other* adults / shared custody rotation (single owner for now).
- Auto-importing school/creche holiday calendars from external feeds (windows are entered manually or via existing sync plugins; auto-ingest is a later, separate spec).
- Notifications/reminders fired off obligations.
- A full visual RRULE builder beyond the common presets (daily, every-N-days, weekdays, weekly, monthly).
