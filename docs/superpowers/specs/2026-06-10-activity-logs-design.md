# Phase 2 — `activity_logs`: a generic "what I did / measured" log

**Status:** Approved (2026-06-10)
**Builds on:** `2026-06-10-plannen-log-design.md` (Phase 1 `/log`). This fills the one gap Phase 1 deferred — things that *happened* with a time/duration/quantity that aren't an event, todo, routine, or profile fact.

## Principle — no categories

The activity is a **free-form label pulled from the user's words**, never an enum. "sleep", "run", "water", "weight", "mood", "screen time" are all just strings. The store is one generic table; sleep is not special. This is the explicit correction to the earlier "sleep + durations" framing — the primitive is general life-logging.

A logged row carries a **duration OR a quantity+unit** (or neither — "had a coffee with Sam" is just activity + notes):
- "slept 8h last night" → `activity:"sleep", duration_minutes:480, occurred_at:<last night>`
- "ran 40 min" → `activity:"run", duration_minutes:40`
- "drank 2L water" → `activity:"water", quantity:2, unit:"L"`
- "weight 72kg" → `activity:"weight", quantity:72, unit:"kg"`
- "mood 4/5" → `activity:"mood", quantity:4, unit:"/5"`

## Schema

New forward-only migration `supabase/migrations/<ts>_activity_logs.sql` (+ Tier 0 runs the same). RLS user-scoped, mirroring `plannen.practices`.

```
plannen.activity_logs(
  id               uuid pk default gen_random_uuid(),
  user_id          uuid not null,                 -- owner/actor (RLS scope)
  family_member_id uuid null references plannen.family_members(id) on delete cascade,
  activity         text not null,                 -- free label; grouping key for queries
  occurred_at      timestamptz not null default now(),
  duration_minutes integer null check (duration_minutes is null or duration_minutes >= 0),
  quantity         numeric null,
  unit             text null,
  notes            text null,
  tags             text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
)
-- indexes: (user_id, occurred_at desc), (user_id, lower(activity))
-- RLS: select/insert/update/delete where user_id = auth.uid() (mirror practices policies)
```

No `started_at`/`ended_at` in MVP — `occurred_at` (the anchor) + `duration_minutes` is enough for "how much did I sleep this week". Precise start/end can be added later if "what time do I usually sleep" becomes a need.

## MCP tools (all in BOTH runtimes, parity-checked)

### `log_activity`
`log_activity({ activity, occurred_at?, duration_minutes?, quantity?, unit?, notes?, tags?, family_member_id? })`

Inserts one row. The model maps natural language → fields and resolves coarse times ("last night", "this morning") to `occurred_at` in the profile timezone (default now).

**Server-side routine tick (the "both" rule).** After inserting, `log_activity` looks for a **conservative single match** active practice whose name matches `activity` (same matching as `log_completion`) and, if found, marks it done for `occurred_at`'s date (idempotent). This keeps the "log the activity *and* tick the streak" behavior atomic and robust on mobile — no reliance on the model making a second call. Returns the inserted row plus `marked_routine?: { practice_id, name }` when it ticked one.

Strong imperative description (the lesson from Phase 1 — mobile reads tool descriptions, not server instructions): *"CALL THIS IMMEDIATELY when the user reports doing something with a duration or a measured amount ('slept 8h', 'ran 40 min', 'drank 2L', 'weight 72kg', 'mood 4/5'). Do not just reply conversationally."*

### `list_activity_logs`
`list_activity_logs({ activity?, from?, to?, family_member_id?, limit? })`

Returns matching rows (newest first) so the model answers "how much did I sleep this week" / "how often do I run" by summing/counting the rows. **Aggregation stays in the model** for MVP — no stats endpoints.

### `delete_activity_log`
`delete_activity_log({ id })`

Removes one row — the undo path. If the original `log_activity` also ticked a routine, undo additionally calls `unmark_practice_done` (the model has the `marked_routine` info from the log receipt).

## Routing (updates to Phase 1)

The Phase 1 "⏳ coming soon" branch in `plannen-log` (case 4) becomes a real `log_activity` call, and the server instructions / `log_completion` description gain the duration/quantity split:

| Input | Tool | Why |
|---|---|---|
| "just finished gym" (binary done) | `log_completion` | no duration/quantity — it's a completion |
| "ran 40 min" / "slept 8h" / "drank 2L" | `log_activity` | has a duration or quantity |
| "ran 40 min" **and** a "run" routine exists | `log_activity` (ticks the routine server-side) | the "both" rule, one call |
| "how much did I sleep this week?" | `list_activity_logs` | query |

**The split rule, stated once:** a duration or a measured quantity → `log_activity`. A bare "done X" with neither → `log_completion`. Both bypass the intent gate and print a one-line receipt ending `· undo?`.

Receipts:
- `✓ Logged sleep 8h · last night · undo?`
- `✓ Logged water 2L · undo?`
- `✓ Logged run 40min + marked "Run" done · undo?` (overlap)

## Surfaces

**Chat/MCP-first — no web UI in this phase** (mirrors how attendances shipped in 0.4.0: data + tools now, "agent-managed"). A web view for trends/charts is a deliberate later pass once there's real logged data to design against.

## Delivery checklist

1. Migration `<ts>_activity_logs.sql` (RLS mirrors practices). `npx plannen migrate` on active profile(s).
2. `log_activity` / `list_activity_logs` / `delete_activity_log` in `mcp/src/index.ts` AND `supabase/functions/mcp/tools/` (new `activity.ts` module + register in `index.ts`). `node scripts/check-mcp-parity.mjs` green.
3. Update `plannen-log.md` (case 4 → real tool; the duration/quantity split; overlap receipt) and the shared `PLANNEN_INSTRUCTIONS` in both runtimes.
4. `npx plannen functions deploy` (edge) so mobile gets the new tools.
5. Tests: build (`tsc`), `npm run test:run`, parity. A unit test for the conservative routine-tick + the duration/quantity split.

## Out of scope (later)

- Web UI / trends / charts.
- `started_at`/`ended_at` precise spans and time-of-day analytics.
- Per-activity typed schemas or unit normalization/conversion.
