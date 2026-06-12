# Event subject attribution — "not my busy time"

**Date:** 2026-06-12
**Branch:** `fix/events_overlap`
**Status:** Design approved, pending spec review

## Problem

An event can belong to someone other than the account owner — a child's school
sports day, a friend's party you're just tracking. The owner wants it **visible**
on their Plannen calendar, but it should **not count as the owner being busy**: it
must not raise the `⚠ overlaps` clash badge against the owner's own events.

Today events have no notion of *who is busy*, so `overlappingIds()` compares every
timed event against every other one globally and flags any overlapping pair — a
child's event falsely "blocks" the parent.

Two facts shape the model:

1. **Attribution ≠ busy.** "Milo's swimming, drop & leave" and "Milo's swimming, I
   sit on the bench" are attributed identically but are opposite for the owner's
   busy time. So *whose event it is* and *does it occupy my time* are independent.
2. **The subject isn't always family.** In Plannen a "friend" is another user
   account reached via the `relationships` table (`users` ↔ `users`, status
   `accepted`); there is no lightweight contact record. So the busy-subject can be
   the owner, a `family_members` row, or a `users` row. `family_member_id` alone
   can't express the friend case — matching the existing `assigned_to` comment:
   *"no FK so it can later point at a user or family member."*

## Chosen model

A **polymorphic subject** plus an independent **owner-attends** flag on `events`:

- **`subject_kind`** — `NULL` = the owner's own event · `'family_member'` ·
  `'user'` (a connected friend/partner). Extensible (`'contact'`, …) with no new
  column.
- **`subject_id`** — the row id in the matching table. No DB FK (app-validated,
  same convention as `assigned_to`); RLS scopes lookups to the caller's people.
- **`owner_attends`** — boolean, default `false`. Only meaningful when a subject is
  set. `true` = the owner also occupies this time.

**Clash rule** (replaces the global "every timed event clashes" behaviour):

```
counts as the owner's busy time  =  subject_id IS NULL      (owner's own event)
                                 OR  owner_attends = true    (someone else's, owner is there)
```

Events that don't count as busy still **render** on the calendar — they just drop
out of clash detection, exactly as `reminder`-kind events and attendances already do.

| Event | subject_kind | subject_id | owner_attends | Clashes vs owner's events? |
|---|---|---|---|---|
| My 10:00 call | NULL | NULL | — | yes |
| Milo's sports day (drop & leave) | family_member | Milo | false | no |
| Milo's swimming (I stay) | family_member | Milo | true | yes |
| Friend's party (just tracking) | user | <friend user id> | false | no |

No per-person busy timelines in this pass: two of Milo's own events overlapping
will *not* clash (accepted simplification — the model is binary "is this the
owner's time," not a full multi-calendar). Forward-compatible if per-subject
timelines are ever wanted.

Surface for this pass: **agent-driven + display chip**. The agent sets the subject
and `owner_attends` from natural language; the card shows whose event it is. No web
editor control yet.

## Changes

### 1. Schema (forward-only migration)

New additive timestamped migration under `supabase/migrations/`:

```sql
alter table plannen.events
  add column subject_kind  text
    check (subject_kind in ('family_member', 'user')),
  add column subject_id    uuid,
  add column owner_attends boolean not null default false;

-- both set together or both null
alter table plannen.events
  add constraint events_subject_pair
    check ((subject_kind is null) = (subject_id is null));
```

All nullable / defaulted; NULL subject = owner's event. No backfill. Tier-0 overlay
(`supabase/migrations-tier0/`) unaffected — it only stubs `auth.*`/`storage.*`/roles.
Apply via `npx plannen migrate` on every active profile; back up first per CLAUDE.md.

### 2. Overlap exclusion

`overlappingIds()` in `src/utils/weekAgenda.ts` — extend the filter so an event
counts toward clashes only when it's the owner's busy time, mirroring the existing
`reminder` skip:

```ts
.filter((e) =>
  e.event_kind !== 'reminder' &&
  (e.subject_id == null || e.owner_attends) &&   // ← only the owner's own time clashes
  e.start_date.length > 10)
```

**Mirror status (verified):** `overlappingIds` is defined only in
`src/utils/weekAgenda.ts` and used only by the web (`ScheduleOverview.tsx`). It is
**not** one of the byte-identical engine-parity files (`check-engine-parity.mjs`
guards only `practices.ts`/`scheduling.ts` across runtimes), so this is a
single-file edit with no parity constraint.

**Still to handle:** `get_briefing_context` in `mcp/src/index.ts` does its **own**
clash detection (it treats obligations like timed events). That is a separate
hand-written path — not a mirror — and must apply the same "only the owner's busy
time clashes" rule so the briefing doesn't flag a subject event the owner isn't
attending.

### 3. Read + write plumbing (MCP parity-critical)

Per CLAUDE.md the two MCP implementations must stay in sync
(`scripts/check-mcp-parity.mjs`).

- **Write:** add optional `subject_kind`, `subject_id`, `owner_attends` parameters to
  `create_event` and `update_event` in **both** `mcp/src/index.ts` and the mirrored
  `ToolModule` under `supabase/functions/mcp/tools/`. Validate: the pair is both-set
  or both-null; `subject_id` resolves to a `family_members` row (when
  `family_member`) or an accepted relationship's `users` row (when `user`) within the
  caller's scope; `owner_attends` ignored/forced false when no subject.
- **Read:** include the three columns in every event SELECT — `list_events`,
  `get_event`, `get_briefing_context`, and any others returning event rows — in both
  impls. Optionally resolve `subject_name` server-side for display; otherwise the web
  resolves it from already-loaded data (see #5).

### 4. Web types

Add `subject_kind?: 'family_member' | 'user' | null`, `subject_id?: string | null`,
`owner_attends?: boolean` to the `Event` type in `src/types/event.ts` and to the row
mappers in `src/services/eventService.ts` / `src/lib/dbClient`. `eventService`
continues to set `assigned_to` only for todos; the subject fields are independent and
default to null/false.

### 5. Display chip

In `src/components/ScheduleOverview.tsx`, render a small muted chip with the subject's
name on events where `subject_id` is set. Resolve the name by kind: `family_member` →
`family_members.name` (already loaded), `user` → the connected user's `full_name` from
the relationships list. When `owner_attends` is true the event still shows the chip
*and* keeps normal clash behaviour. The `⚠ overlaps` badge disappears for non-attended
subject events automatically via #2 — no extra suppression code.

### 6. Agent / intent gate (plugin skill)

Update the event-creation guidance in `plugin/skills/` (plannen-core intent gate):
when an event is clearly for a specific person other than the owner — "Milo's sports
day", "Tom's party" — the agent resolves the subject (search `list_family_members`
first, then accepted relationships via `list_relationships`), sets
`subject_kind`/`subject_id`, and infers `owner_attends` from phrasing ("Milo has
swimming" → false; "I take Milo to swimming and wait" → true), defaulting to `false`
when ambiguous (the safer "don't nag me with overlaps" default). Note in the skill
that a non-attended subject event is excluded from the owner's clash detection, so the
agent shouldn't also warn about overlaps for it.

## Out of scope (YAGNI)

- Per-subject busy timelines (two of one child's events clashing with each other).
- Web event-editor control to set/clear the subject or `owner_attends` by hand.
- Friend-specific UI — the `'user'` kind works through the same path the moment a
  relationship exists, but no new social surface is built here.
- Multiple subjects/attendees per event.
- Any Google Calendar free/busy ("transparency") behaviour — there is no gcal sync
  code; sync is agent-driven and this feature is purely Plannen-internal.

## Testing

- `overlappingIds()` unit tests: owner event + non-attended subject event at the same
  time → empty set (no clash); owner event + subject event with `owner_attends=true`
  → both flagged; two owner events at the same time → both flagged.
- `create_event`/`update_event` round-trip the three fields through `get_event` /
  `list_events` in both MCP impls; pair constraint and subject-scope validation
  enforced.
- Parity: `scripts/check-mcp-parity.mjs` and `check-engine-parity.mjs` pass.
- Migration applies cleanly on a Tier-0 profile via `npx plannen migrate`.
