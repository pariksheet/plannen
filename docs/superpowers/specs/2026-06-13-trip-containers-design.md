# Trip Containers — design

**Date:** 2026-06-13
**Status:** Approved (brainstorm)

## Problem

Plannen has no way to group a set of activities under one umbrella. A multi-day
trip (a 2-week vacation, a wedding weekend, a festival, a school-holiday week)
must today be entered either as one big spanning event — which loses the
individual activities — or as a pile of unrelated events — which loses the "this
is all one trip" framing and any shared prep checklist.

Note what already works and is **not** the gap: the calendar already paints any
non-`session` event with a later `end_date` as a multi-day band
(`src/components/CalendarGrid.tsx:106-124`). Multi-day *rendering* exists. The
missing primitive is **grouping**: an umbrella that owns sub-events, todos, and
memories so they can be planned and viewed together.

## Goal

A generic **container** primitive (UI label: "Trip") that is both:

- a **calendar band** spanning its date range, and
- a **planning hub** bundling child events + named todo lists + memories.

The container is deliberately generic (trips, festivals, weddings, move-week),
not vacation-specific.

## Scope (v1)

In scope:

- Container is itself an event (`event_kind='container'`), reusing memories,
  notes, photos, and the existing multi-day band rendering.
- Children (events **and** todos) link to a container via a new `group_id`.
- Children can be **created inside** a container or **assigned** to one later
  (and unassigned).
- Children appear **both** as the trip band and on their own calendar days, with
  a subtle visual cue tying them to the trip.
- A few **named todo lists** within a trip (Packing / To-do / Shopping), via a
  `list_label` on todos.
- Children **inherit** the container's `event_type` / sharing by default
  (overridable).

Explicitly out of scope (deferred, none block the core):

- Budgets, itinerary-specific fields, separate `trips`/`packing` tables.
- Nested containers (a container inside a container).
- New `event_status` values or a container lifecycle state machine.
- Any change to the recurrence/scheduling engine.

## Data model

Three additions to the `events` table (additive timestamped migration under
`supabase/migrations/`; Tier 0 overlay unaffected):

| Change | Detail |
|---|---|
| `event_kind = 'container'` | New allowed value; update the `events_event_kind_check` constraint to `IN ('event','reminder','session','todo','container')`. |
| `group_id uuid NULL` | `REFERENCES events(id) ON DELETE SET NULL`. Child events and child todos point at their container. Index `idx_events_group_id`. |
| `list_label text NULL` | Only meaningful on `event_kind='todo'` rows with a `group_id`. Free-text; UI offers presets (Packing / To-do / Shopping). |

Rules:

- A container's own `group_id` must be `NULL` (no nested trips in v1). Enforced
  in the MCP layer (reject assigning a container into another container).
- `group_id` must reference an `event_kind='container'` row owned by the same
  user (validated in the MCP handler via `auth.uid()` / user context).
- **Detach on delete:** deleting a container sets children's `group_id` to NULL.
  It never destroys child events — a standalone dentist appointment must survive
  the deletion of the trip wrapper. Guaranteed by `ON DELETE SET NULL`.
- `group_id` is intentionally separate from `parent_event_id`, which stays
  reserved for recurrence sessions. The two are orthogonal; v1 does not combine
  them.

**No engine change.** Containers are not recurring and children are plain
events, so the byte-identical 3-runtime engine
(`mcp/src/{practices,scheduling}.ts`, the Deno edge copies, and
`src/utils/scheduling.ts`) stays untouched. `check-engine-parity.mjs` remains
green without edits.

## MCP tools

All tool changes must land in **both** servers and pass
`scripts/check-mcp-parity.mjs`: `mcp/src/index.ts` (Tier 0 stdio) and
`supabase/functions/mcp/tools/events.ts` (Tier 1/2 edge, the one Claude Code
talks to). No new tool is introduced.

- **`create_event`** — accept `event_kind:'container'`; accept `group_id` and
  `list_label`. When `group_id` is provided and `event_type`/`shared_with_family`
  /`shared_with_friends` are omitted, inherit them from the container row.
  Explicit values override. Reject `group_id` that points at a non-container,
  another user's row, or (for a container being created) any non-null group.
- **`update_event`** — accept `group_id` (set = assign an existing event into a
  trip; `null` = remove it) and `list_label`. `event_kind` stays immutable, as
  today. Same validation as create for `group_id`.
- **`list_events`** — add a `group_id` filter param returning a container's
  members, ordered by `start_date ASC`. Callers must pass `limit: 50+` (default
  10 silently truncates).

`get_event` already returns the container's own row; `list_events({group_id})`
returns its contents. Together they are the entire planning-hub fetch.

## Web / UI

- **Types** (`src/types/event.ts`): add `'container'` to `EventKind`; add
  `group_id` and `list_label` to the `Event` interface.
- **Calendar** (`src/components/CalendarGrid.tsx`): container renders as the
  multi-day band (already covered by existing range logic, since it is not a
  `session`). Child activities show on their own days **and** carry a subtle
  marker (left border / chip in the trip's accent) signalling trip membership.
  This is a minimal nesting cue, not a CalendarGrid redesign.
- **Trip detail panel:** clicking the band opens a hub showing trip info, child
  activities (chronological), and named todo lists grouped by `list_label` with
  check-off (reusing `complete_todo` / `uncomplete_todo`). Photos and notes
  attach to the container via the existing `event_memories` / `event_notes`
  tables — no new wiring.

## Edge cases

- **Event already in another group:** assigning overwrites `group_id` (one group
  per event in v1).
- **Container deletion:** children detached, not deleted (see Data model).
- **`list_events` truncation:** trip-member fetches must use `limit: 50+`.
- **Inheritance override:** a child explicitly passing its own sharing keeps it;
  inheritance only fills omitted fields at create time and is not re-applied on
  later container edits.

## Migration / safety

- Forward-only additive migration under `supabase/migrations/`; apply via
  `npx plannen migrate` on every active profile. Back up first
  (`bash scripts/export-seed.sh` for Tier 1, or tar `~/.plannen/pgdata` for
  Tier 0). Never `supabase db reset`.
- After tool changes: rerun `npm run check:parity` (MCP + engine) and
  `npm run test:cli`.

## Testing

- Migration applies cleanly; check constraint accepts `'container'`.
- `create_event` with `event_kind='container'` + `end_date` → band renders.
- Create child with `group_id` → inherits sharing; appears under
  `list_events({group_id})` and on its own day.
- `update_event` assign/unassign round-trips `group_id`.
- Todo with `list_label` buckets correctly; `complete_todo` toggles it.
- Delete container → children survive with `group_id = NULL`.
- Parity scripts and CLI tests green.
