# Unified Scheduling — Phase 2 (attendances + blackouts) + Phase 3 (derived obligations) Implementation Plan

> Derived from the approved design `docs/superpowers/specs/2026-06-10-unified-scheduling-design.md`. Phase 1 (unified recurrence on practices) shipped in 0.3.0 and is the pattern this mirrors. Examples use generic personas (Milo/Nora/"example school") — repo is PUBLIC.

## Grounded patterns (verified against code)

- **Recurrence**: reuse the Phase-1 JSONB shape, NOT raw RRULE strings. `mcp/src/practices.ts` exports `RecurrenceRule = {frequency,interval?,days?}` (days = MO..SU), `occursOn(rule, dtstart, date)`, `weekBoundaryStart`, `monthBoundaryStart`, `dayOfWeekKey`. Attendances are always pinned → use `occursOn` + a `recurrence_until` upper-bound guard. Dates are `YYYY-MM-DD` UTC strings; no `Date.now()` in pure code.
- **Migration idiom** (from `20260519120000_daily_plan_agent.sql`): `id uuid primary key default extensions.uuid_generate_v4()`, `user_id uuid not null references auth.users(id) on delete cascade`, `created_at/updated_at timestamptz default now()`, partial index `where active`, `enable row level security`, policy `"<name>: owner only" using (auth.uid()=user_id) with check (auth.uid()=user_id)`, reuse `plannen.touch_practices_updated_at()` trigger, `grant all ... to anon, authenticated, service_role`. Locations table is `plannen.user_locations(id)`; members `plannen.family_members(id)`.
- **Dual MCP**: Tier 0 = `async function` + `{name,description,inputSchema}` in `TOOLS: Tool[]` + dispatch `case`. Tier 1 = `ToolModule {definitions, dispatch}` file under `supabase/functions/mcp/tools/`, imported into the `TOOLS: ToolModule[]` registry in `supabase/functions/mcp/index.ts`. Parity (`scripts/check-mcp-parity.mjs`) matches `name:` lines in both. Handlers `(args, ctx)` with `ctx.client`/`ctx.userId`; JSONB passed via `JSON.stringify`.
- **Shared engine**: new pure module mirrored `mcp/src/scheduling.ts` ↔ `supabase/functions/_shared/scheduling.ts` (only import-path/comment header differs; diff-gated).
- **Deploy**: `npx plannen migrate`; `npx plannen functions deploy` (applies `--no-verify-jwt` — MUST use, raw `supabase functions deploy` breaks bearer auth); `npx plannen deploy`.

## Override-resolution + projection (the subtle core)

1. **Expand** each active attendance over the window via `occursOn`, bounded by `recurrence_until`.
2. **Suppress** instances whose date is inside any linked blackout window (`starts_on`/`ends_on` inclusive).
3. **Resolve per (member, date)** on survivors: highest `priority` wins; tie → bounded (`recurrence_until != null`) beats open-ended; residual tie → later `dtstart`, then `attendance_id`.
4. **Project** each active obligation onto its member's winning instance: `drop` = `winner.start_time + offset` (offset negative, −15 → 08:15); `pick` = `winner.end_time + offset` (0 → 16:00; Wed 12:00 end → 12:00 pick, no special rule); `location_id = obligation.location_id ?? winner.location_id` (camp swap inherits camp location); null anchored time → no projection. **Obligations project onto the member's winning instance regardless of which attendance they were derived from** — so drop/pick "follow the child" to camp.
5. **Conflict feed**: obligations are actionable (clash-checked); attendances + blackouts indicative (excluded like `reminder`). `overlappingIds` unchanged.

## Phase 2 tasks
- **2.1** Migration: `attendances`, `blackout_calendars`, `blackout_windows`, `attendance_blackouts` (additive, RLS owner-only).
- **2.2** Pure engine `mcp/src/scheduling.ts` (+test): `dateInWindow`, `isSuppressed`, `expandAttendance`, `expandAndSuppress`. TDD.
- **2.3** Mirror to `supabase/functions/_shared/scheduling.ts` (diff-gated).
- **2.4** Tier 0 MCP tools: create/update/list/delete_attendance, create_blackout_calendar, add_blackout_window, list_blackout_calendars, link_attendance_blackout.
- **2.5** Tier 1 module `tools/scheduling.ts` (parity) + register.
- **2.6** Briefing: `attendances_today` (expanded+suppressed), both tiers.
- **2.7** Web types + read route + indicative rendering (lower priority).
- **2.8** Verify + agent guidance + deploy.

## Phase 3 tasks
- **3.1** Migration: `obligations` (role drop|pick, anchor start|end, signed offset_minutes, location_id null=inherit).
- **3.2** Engine: `resolveOverride`, `projectObligation`, `addMinutesToClock` (+ `_shared` mirror). TDD — this is the correctness crux.
- **3.3** MCP tools obligations (both tiers, parity).
- **3.4** Briefing: `obligations_today` (resolve→project), both tiers.
- **3.5** Web rendering + intent-gate guidance in plannen-core (lower priority).
- **3.6** Verify + worked-example smoke + deploy + version bump + PR.

See the design spec for full rationale and the worked example.
