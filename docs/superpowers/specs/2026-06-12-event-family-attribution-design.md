# Event family-member attribution — "not my busy time"

**Date:** 2026-06-12
**Branch:** `fix/events_overlap`
**Status:** Design approved, pending spec review

## Problem

An event can belong to a family member rather than the account owner — e.g. a
child's school sports day. The owner wants it **visible** on their Plannen
calendar, but it should **not count as the owner being busy**: it must not raise
the `⚠ overlaps` clash badge against the owner's own events. Today, events have
no notion of *who is busy*, so `overlappingIds()` compares every timed event
against every other one globally and flags any pair that overlaps — a child's
event falsely "blocks" the parent.

Example: "Sports day" is the child Milo's event. It should sit on the parent's
calendar but never clash with the parent's 10:00 call.

## Chosen model

**Binary "not me" flag, carried by attribution.** An event is either:

- **Owner's** (`family_member_id IS NULL`) — participates in clash detection
  exactly as today.
- **A family member's** (`family_member_id` set) — still renders on the
  calendar, but is **excluded from clash detection entirely**, the same way
  `reminder`-kind events and attendances already drop out.

No per-person busy timelines in this pass (two of Milo's own events overlapping
will *not* clash — accepted simplification). The `family_member_id` link is
forward-compatible if per-member timelines are ever wanted later.

Surface for this first pass: **agent-driven + display chip**. The agent sets
attribution from natural language; the card shows whose event it is. No web
editor control yet.

## Changes

### 1. Schema (forward-only migration)

New additive timestamped migration under `supabase/migrations/`:

```sql
alter table plannen.events
  add column family_member_id uuid references plannen.family_members(id);
```

Nullable, no default (NULL = owner's). No backfill needed. Tier-0 overlay
(`supabase/migrations-tier0/`) is unaffected — it only stubs `auth.*`/`storage.*`
/roles, not app tables. Apply via `npx plannen migrate` on every active profile;
back up first per CLAUDE.md.

### 2. Overlap exclusion

`overlappingIds()` in `src/utils/weekAgenda.ts` — add a filter clause so events
with a non-null `family_member_id` are skipped, mirroring the existing
`e.event_kind !== 'reminder'` skip:

```ts
.filter((e) =>
  e.event_kind !== 'reminder' &&
  !e.family_member_id &&            // ← new: a member's event is not the owner's busy time
  e.start_date.length > 10)
```

**Parity check during implementation:** confirm whether `overlappingIds` has a
mirrored copy in the scheduling engine (`mcp/src/scheduling.ts` /
`supabase/functions/_shared/scheduling.ts`) that must stay byte-identical under
`scripts/check-engine-parity.mjs`. Also confirm the `get_briefing_context` clash
logic in `mcp/src/index.ts` (which treats obligations like timed events for
clash detection) applies the same exclusion, so the briefing doesn't flag a
member's event against the owner.

### 3. Read + write plumbing (MCP parity-critical)

Per CLAUDE.md, the two MCP implementations must stay in sync
(`scripts/check-mcp-parity.mjs`).

- **Write:** add an optional `family_member_id` parameter to `create_event` and
  `update_event` in **both** `mcp/src/index.ts` and the mirrored `ToolModule`
  under `supabase/functions/mcp/tools/`. Validate it references one of the
  caller's family members (RLS scope).
- **Read:** include `family_member_id` in every event SELECT — `list_events`,
  `get_event`, `get_briefing_context`, and any others returning event rows — in
  both impls.

### 4. Web types

Add `family_member_id?: string | null` to the `Event` type in
`src/types/event.ts` and to the row mappers in `src/services/eventService.ts` /
`src/lib/dbClient`. `eventService` continues to set `assigned_to` only for
todos; `family_member_id` is independent and defaults to null.

### 5. Display chip

In `src/components/ScheduleOverview.tsx`, render a small muted chip with the
family member's name on events that have `family_member_id` set (resolve name
from the already-loaded family-members list). The `⚠ overlaps` badge disappears
for these events automatically via change #2 — no extra suppression code.

### 6. Agent / intent gate (plugin skill)

Update the event-creation guidance in `plugin/skills/` (plannen-core intent
gate) so that when an event is clearly for a specific family member and not the
account owner — phrasings like "Milo's sports day", "the kids' dentist" — the
agent resolves the member via `list_family_members` and passes
`family_member_id` to `create_event`. Note in the skill that such an event is
excluded from the owner's clash detection (so the agent shouldn't also warn
about overlaps for it).

## Out of scope (YAGNI)

- Per-member busy timelines (two of one child's events clashing with each other).
- Web event-editor dropdown to set/clear attribution by hand.
- Multiple attendees per event / attendee lists.
- Any Google Calendar free/busy ("transparency") behaviour — there is no gcal
  sync code; sync is agent-driven and this feature is purely Plannen-internal.

## Testing

- `overlappingIds()` unit test: an owner event + a member event at the same time
  → the set is empty (no clash). Two owner events at the same time → both flagged.
- MCP parity: `scripts/check-mcp-parity.mjs` and `check-engine-parity.mjs` pass.
- `create_event` with `family_member_id` round-trips through `get_event` /
  `list_events` in both MCP impls.
- Migration applies cleanly on a Tier-0 profile via `npx plannen migrate`.
