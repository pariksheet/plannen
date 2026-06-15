# Overdue todos in the daily brief — design

**Date:** 2026-06-15
**Branch:** `fix/plannen_brief`

## Problem

The daily brief (`/plannen-today`) only ever looks at today, a light tomorrow
preview, and the last 7 days of past *events* for context. Incomplete todos
whose due date has already passed are never surfaced — they silently fall off
the radar. The brief should remind the user of overdue todos.

## Scope

In scope:

- Overdue **todos only**: `event_kind = 'todo'`, not completed, not cancelled,
  with a `start_date` (due date) before today, within the last 30 days.

Explicitly out of scope (considered and dropped during brainstorming):

- Missed practices (a pinned practice due on a past day but never marked done).
- Past untracked events (recent events with no RSVP/attendance/memory).

These may be revisited later but are not part of this change.

## Definition of "overdue"

A todo is overdue when **all** of:

- `event_kind = 'todo'`
- `completed_at IS NULL` — open. (`complete_todo` sets `completed_at`;
  `uncomplete_todo` clears it. This is the canonical done-flag.)
- `event_status <> 'cancelled'`
- `start_date::date` is **between 30 days ago and yesterday** (inclusive).
  Today's todos are excluded — they already render in the Schedule section.
  Todos older than 30 days drop off silently to keep the section tight.

## Design

### 1. Data layer — `get_briefing_context`

Add one more query to the existing `Promise.all` batch, mirroring the shape of
the `recent_past_events` query:

```sql
SELECT id, title, start_date, location, event_kind
FROM plannen.events
WHERE created_by = $1
  AND event_kind = 'todo'
  AND completed_at IS NULL
  AND event_status <> 'cancelled'
  AND start_date::date BETWEEN ($2::date - INTERVAL '30 days')::date
                           AND ($2::date - INTERVAL '1 day')::date
ORDER BY start_date ASC
```

- `$1` = user id, `$2` = the briefing date (`today`).
- Result exposed as a new `overdue_todos` array on the return object, alongside
  `events_today`, `events_tomorrow`, `recent_past_events`, etc.
- Sorted oldest-first so the most overdue item is first.

This must be applied to **both** MCP runtimes, kept behaviourally identical:

- `supabase/functions/mcp/tools/briefings.ts` (Tier 1/2 edge — the one Claude
  Code actually talks to).
- `mcp/src/index.ts` (Tier 0 local stdio server), in the
  `get_briefing_context` handler.

Note: `scripts/check-mcp-parity.mjs` only verifies a tool *name* exists in both
implementations. The SQL/logic staying in sync is a manual responsibility, so
both files are edited in this change.

### 2. Composition layer — `plannen-day-plan` skill

Document a new `## Overdue` section in
`plugin/skills/plannen-day-plan.md`, rendered **above Schedule**:

```markdown
## Overdue
- [ ] Renew passport (due 12 Jun)
- [ ] Call plumber (due 5 Jun)
```

Rules:

- Checkbox bullet style (matches Practices today).
- Each line shows the original due date as `(due D Mon)`.
- Oldest-first ordering (most overdue at top), as returned by the query.
- **Omit the entire section when `overdue_todos` is empty** — consistent with
  the existing "omit empty sections" rule.
- Counts toward the ~30-line budget. On overflow, overdue ranks just below
  time-conflicted events in render priority.

### 3. Tests

Extend `supabase/functions/mcp/tools/briefings.test.ts` so the overdue query is
asserted to **exclude**:

- Completed todos (`completed_at` set).
- Cancelled todos (`event_status = 'cancelled'`).
- Non-todo kinds (`event`, `reminder`, `container`).
- Today's and future todos.
- Todos with `start_date` older than 30 days.

And to **include** a plain open todo dated within the window.

## Data flow

```
get_briefing_context
  └─ overdue_todos query (new, 30d..yesterday, open, not cancelled)
        ↓
plannen-day-plan skill composes markdown
  └─ "## Overdue" section above "## Schedule" (omitted if empty)
        ↓
save_daily_briefing  → plannen.daily_briefings
        ↓
web /today re-renders the saved markdown
```

## Files touched

- `supabase/functions/mcp/tools/briefings.ts` — new query + `overdue_todos` in return.
- `mcp/src/index.ts` — same change in the Tier 0 `get_briefing_context` handler.
- `plugin/skills/plannen-day-plan.md` — document the `## Overdue` section.
- `supabase/functions/mcp/tools/briefings.test.ts` — overdue inclusion/exclusion tests.

## Out of scope / non-goals

- No schema change (todos and `completed_at` already exist).
- No new MCP tool (extends the existing `get_briefing_context`).
- No change to `save_daily_briefing` / `get_daily_briefing`.
- No web UI work beyond what re-rendering the saved markdown already gives.
