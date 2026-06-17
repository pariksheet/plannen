# Routine precise time — design

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

Practices (routines) only carry a coarse `preferred_time_of_day`
(`morning` / `afternoon` / `evening` / `anytime`). A user who wants a routine
at a specific clock time — e.g. "Brush Niheet Before Sleep" at 20:00 — has no
way to express it, and the routine cannot sit at its real time in the day's
schedule.

## Goal

Let a routine optionally carry a **precise start clock time** (`HH:MM`, 24h).
When set, the routine interleaves into the Today schedule at that time, among
events, as a checkable row. Untimed routines are unchanged.

## Non-goals (YAGNI)

- No per-occurrence time overrides (the time is the same for every occurrence).
- No reminders / push notifications at that time.
- No end time or duration — just a start clock time.
- No precise time for `flex_count` routines ("N×/week, anytime").

## Data model

Add one nullable column to `practices`:

- `precise_time text` — stores `"HH:MM"` (24h), e.g. `"20:00"`.
- CHECK: `precise_time IS NULL OR precise_time ~ '^([01]\d|2[0-3]):[0-5]\d$'`.

It coexists with `preferred_time_of_day`. Precise time **takes precedence** for
sorting and display when set; part-of-day stays the fallback. The column is only
meaningful for `pinned` routines; `flex_count` routines leave it NULL. This is
enforced softly in the form (the input is hidden unless mode is `pinned`), not
as a hard DB cross-field constraint.

Forward-only, additive migration: `supabase/migrations/<ts>_practice_precise_time.sql`.

## Behavior: the interleave

The Today view already merges routine rows and event rows into one list ordered
by sort-minutes (`ScheduleOverview.tsx:503-507`). The only logic change lives in
the **web-only** `src/utils/routineToday.ts`:

- `partOfDayMins(tod)` → `partOfDayMins(tod, precise_time)`.
  - If `precise_time` is a valid `HH:MM`, return `h*60 + m`.
  - Else fall back to the existing mapping: morning 480, afternoon 780,
    evening 1080, anytime `+Infinity`.
- Call site sets `sortMins: partOfDayMins(p.preferred_time_of_day, p.precise_time)`.

So a 20:00 routine sorts to 20:00 in the flow (e.g. after an 18:15 event);
untimed routines behave exactly as today.

`routineToday.ts` is web-only and is **not** part of the byte-identical engine
mirror (`practices.ts` + `scheduling.ts` across the three runtimes), so this
change introduces no parity churn.

Timed routines remain habits: they are never passed to the clash checker
(`overlappingIds`, which only takes Events), so they never produce overlap
warnings.

## UI

- **Display:** the routine row gets a muted `HH:MM` prefix when timed, matching
  how event rows render their time. `routineToday.ts` exposes a `timeLabel`
  (`"HH:MM"` or `""`) that the row in `ScheduleOverview.tsx` renders.
- **Form** (`ProfileRoutines.tsx`): add an `<input type="time">` shown only when
  `recurrence_mode === 'pinned'`. Wire through `FormState`, `EMPTY_FORM`,
  `startEdit`, and `buildPatch`.

## MCP (both servers — parity required)

Add `precise_time` (optional `string`, `HH:MM`) to the `create_practice` and
`update_practice` input schemas, the create INSERT column list + params, and the
`list_practices` SELECT, in **both**:

- `supabase/functions/mcp/tools/practices.ts` (edge — Tier 1/2, what the live
  app/Claude Code hits)
- `mcp/src/index.ts` (local — Tier 0)

`update_practice` uses a dynamic column builder, so it needs no SQL change beyond
schema. Tool names are unchanged, so `check-mcp-parity.mjs` stays green.

## Web types & service layer

- `src/lib/dbClient/types.ts`: `PracticeRow` gains `precise_time: string | null`.
- `src/services/practiceService.ts` and the tier0/tier1 dbClient practice
  methods are already generic (`Partial<PracticeRow>`) pass-throughs — no change.

## Testing

- Unit `partOfDayMins`: precise time beats part-of-day; `null`/invalid falls back
  to the part-of-day mapping.
- WeekCard render: a 20:00 routine interleaves after an 18:15 event and before a
  later one; an `anytime` routine still sorts last.
- MCP create → list round-trip of `precise_time` (mirrors existing practices
  tests), in the edge test suite.
- `npm run check:parity` stays green (no engine-function change; tool names
  unchanged).

## Rollout

1. Backup: `bash scripts/export-seed.sh`.
2. Apply migration: `npx plannen migrate` (tier-aware; Tier 2 → `supabase db push`).
3. Deploy the `mcp` edge function + web: `npx plannen deploy`.

## Change surface (files)

1. `supabase/migrations/<ts>_practice_precise_time.sql` (new)
2. `supabase/functions/mcp/tools/practices.ts` (edge MCP)
3. `mcp/src/index.ts` (local MCP)
4. `src/lib/dbClient/types.ts` (`PracticeRow`)
5. `src/utils/routineToday.ts` (`partOfDayMins` + `timeLabel`)
6. `src/components/ScheduleOverview.tsx` (routine row time prefix)
7. `src/components/ProfileRoutines.tsx` (form field)
8. Tests alongside the above.
