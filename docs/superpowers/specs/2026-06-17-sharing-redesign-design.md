# Sharing Redesign — Design Spec

**Date:** 2026-06-17
**Branch:** `feat/revisit_sharing`
**Status:** Approved design, pending implementation plan

## Problem

Sharing in Plannen is fragmented and under-powered. Today it spans three
disjoint mechanisms — the `shared_with_friends` enum on `events`, the
`event_shared_with_groups` junction, and the `event_shared_with_users`
junction — gated by three separate RLS SELECT policies. There is:

- **No default sharing.** Every item must be shared manually; there is no
  standing rule like "share my new items with My Family."
- **No permission level.** Shares are implicitly read-only (RLS grants only
  SELECT), but there is no way to express a stronger "this is yours to do"
  share, nor a clean "FYI, not on my plate" treatment for the recipient.
- **No recipient control.** A shared event simply appears; the recipient can't
  decide whether it belongs on their own agenda.
- **No trip sharing.** Trip containers (`event_kind='container'`) never surface
  in group views — the known gap from the prior trip-sharing decision.

## Goals

Driven by three concrete user requirements:

1. **Default sharing.** One global rule applied at create time ("new items →
   share with My Family at awareness level"), overridable per item to a
   different target, a stronger level, or fully private.
2. **Read-only / non-blocking awareness.** A shared item informs the recipient
   without claiming their agenda. It lands in a "Shared with me" inbox; the
   recipient **opts in per item** to pull it onto their own agenda.
3. **Assignable todos.** A shared todo can be assigned so the recipient can
   complete it. Assignment is **co-ownership**: it appears in both lists and
   whoever finishes marks it done for both.

Non-goal: a per-share audit trail, per-column edit permissions beyond
completion, or Tier-0 cross-user sharing (Tier 0 remains single-user; share
reads return empty there as today).

## Conceptual model

Every share — to a person, a group, or "all my connections" — is **one row in
one table** (`event_shares`) carrying a **level**:

| Level | Set by | Recipient can | Lands in recipient's… |
|---|---|---|---|
| `awareness` (read-only) | default rule or per-item | view only; opt-in to adopt onto own agenda | "Shared with me" inbox → agenda on opt-in |
| `assigned` (co-own, todos only) | explicit, per-todo | view + mark complete (done-for-both) | their todo list directly (skips inbox) |

- **Default rule** is global and always at `awareness` level. Assignment is
  never a default — always an explicit per-todo gesture.
- **Trips** fold in: sharing a container writes one `event_shares` row on the
  container; its children (linked by `group_id`) surface through it. This is
  the previously-decided "share once → children follow" — no per-child copy.

## Data model

### New table `event_shares`

Replaces `event_shared_with_groups`, `event_shared_with_users`, and the
`shared_with_friends` enum as the source of truth for who can see an event.

```
event_shares
  id          uuid pk default gen_random_uuid()
  event_id    uuid not null → plannen.events(id) on delete cascade
  target_type text not null check in ('user','group','all')
  target_id   uuid null            -- null iff target_type='all'
  level       text not null default 'awareness' check in ('awareness','assigned')
  created_by  uuid not null
  created_at  timestamptz not null default now()
  unique (event_id, target_type, target_id)
```

Because Postgres treats NULLs as distinct in a UNIQUE constraint, the
`(event_id, target_type, target_id)` unique does **not** prevent two
`target_type='all'` rows (both with `target_id=null`). Add a partial unique
index to cover that case: `unique (event_id) where target_type='all'`.

- `target_type='all'` ⇒ `target_id IS NULL`; otherwise `target_id` is a
  `user_id` (for `'user'`) or a `friend_groups.id` (for `'group'`). Enforced by
  a CHECK constraint.
- `level='assigned'` is only meaningful for `event_kind='todo'`. Not enforced
  by constraint (a todo can be reclassified); the app and `complete_event` RPC
  only honor it for todos.

### New table `event_share_adoption`

Per-recipient opt-in for awareness items.

```
event_share_adoption
  event_id   uuid not null → plannen.events(id) on delete cascade
  user_id    uuid not null
  adopted_at timestamptz not null default now()
  primary key (event_id, user_id)
```

A row means "this awareness share has been pulled onto the user's own agenda."
Assigned todos do **not** require an adoption row — they surface automatically.

### `user_settings` — default rule

Add columns to the existing one-row-per-user table:

```
default_share_enabled     boolean not null default false
default_share_target_type text null check in ('user','group','all')
default_share_target_id   uuid null
default_share_level       text not null default 'awareness'
                          check (default_share_level = 'awareness')
```

`default_share_level` is constrained to `'awareness'` — defaults never assign.

### Migration (forward-only, additive, backup-first)

Per the repo's hard rules: forward-only, no `db reset`, back up first
(`bash scripts/export-seed.sh` Tier 1, or tar `~/.plannen/pgdata + photos`
Tier 0). Steps:

1. Create `event_shares` + `event_share_adoption`; add `user_settings` columns.
2. **Backfill `event_shares`** from existing data, all at `level='awareness'`:
   - `event_shared_with_groups` → `(target_type='group', target_id=group_id)`
   - `event_shared_with_users` → `(target_type='user', target_id=user_id)`
   - `events.shared_with_friends='all'` → `(target_type='all', target_id=null)`
   - `created_by` backfilled from `events.created_by`.
3. Leave the old junctions and the enum **read-dormant for one release** so a
   mid-deploy mix of old/new code never breaks; a later, separate drop
   migration removes them once all readers are migrated.
4. Tier-0 overlay (`supabase/migrations-tier0/`) stubs handled as usual.
5. Verify backfill is row-count-equal to the union of the old sources.

## Row-level security

Replace the three current share SELECT policies on `events` with **one**,
backed by a SECURITY DEFINER helper `plannen.user_can_see_event(p_event_id)`
(SECURITY DEFINER to avoid policy recursion, as the current helpers do). An
event is visible when:

- `created_by = auth.uid()`, **or**
- an `event_shares` row for this event matches the caller:
  - `target_type='user' AND target_id = auth.uid()`, or
  - `target_type='group'` and caller ∈ `friend_group_members(target_id)`, or
  - `target_type='all'` and an **accepted** `relationships` row links caller and
    `created_by`, **or**
- **trip branch:** the event's `group_id` points to a container whose own
  `event_shares` match the caller by any of the above.

Other policies:

- `event_shares`: SELECT gated through the parent event's visibility;
  INSERT/UPDATE/DELETE restricted to the event creator (`created_by =
  auth.uid()` on the parent event).
- `event_share_adoption`: a caller may SELECT/INSERT/DELETE only their own
  (`user_id = auth.uid()`) rows, and only for events they can see.
- **Completion writes** for assignees go exclusively through the
  `plannen.complete_event(p_event_id)` SECURITY DEFINER RPC, which flips
  completion only if the caller is the creator OR an `assigned`-level recipient
  (direct, or via a group they belong to). The events UPDATE policy stays
  creator-only — no broad assignee UPDATE grant.

## Services & MCP tools

Both MCP runtimes must stay in sync (`mcp/src/index.ts` local/Tier-0 and
`supabase/functions/mcp/` edge); every new tool added in **both**, mirrored in
the edge `TOOLS` array, and passing `scripts/check-mcp-parity.mjs`. No tool
reads AI/request-body keys; all `auth.uid()`-scoped.

### Web services (`src/services/`)

- **`shareService` (new):** `setShares(eventId, shares[])`, `addShare`,
  `removeShare`, `adoptShare(eventId)`, `unadoptShare(eventId)`,
  `getSharesFor(eventId)`. Replaces the scattered
  `groupService.setEventSharedWith*` calls.
- **`eventService.createEvent / updateEvent`:** accept a single `share` arg.
  Contract: omitted ⇒ apply the default rule; `share: []` or `private: true` ⇒
  no share; explicit array ⇒ use as given.
- **`containerService.syncTripSharing` → `shareTrip(containerId, share)`:**
  writes one `event_shares` row on the container; the per-child copy logic
  (`applyTripSharingToEvent`) is removed.
- **`viewService`:** rewritten to read `event_shares` (see Views).

### MCP tools (both servers)

- `create_event` / `update_event`: gain the `share` arg with the same contract.
- **New:** `share_event`, `unshare_event`, `assign_todo` (share a todo at
  `assigned` level), `adopt_shared_event` / `unadopt_shared_event`,
  `complete_event` (assignee completion path via the RPC).

## Views

- **My Feed** — my created events (unchanged).
- **Shared-with-me inbox (new surface)** — awareness shares targeting me that I
  have **not** adopted. FYI lane: "from \<sharer\>" tag, "Add to my agenda"
  action that writes an adoption row.
- **My agenda / calendar** — my own events + **adopted** awareness shares +
  **assigned** todos (assigned items appear automatically, no adoption needed).
- **My Groups** — events shared with groups I'm a member of or own, now
  including trip **containers and their children** via the RLS trip branch plus
  a merge/dedupe in `viewService.getGroupsEvents`. This closes the known trip
  gap.

## Default rule application

Applied at the two create sites — web `eventService.createEvent` and MCP
`create_event` in both servers — because they are separate build graphs/runtimes.
Kept as a small shared-shape helper at each site rather than a DB insert
trigger: a trigger cannot distinguish "intentionally private" from "shares not
written yet" (app code inserts shares after the event row). Contract repeated
for clarity:

- `share` omitted ⇒ apply default rule (if `default_share_enabled`).
- `share: []` or `private: true` ⇒ no share, even if a default exists.
- explicit `share` array ⇒ used verbatim.

## Testing

- `npm run check:parity` green — both `check-mcp-parity.mjs` and
  `check-engine-parity.mjs`.
- Migration applies forward-only against a backed-up DB; backfill row-count
  equals the union of the old junction rows + `shared_with_friends='all'` rows.
- **RLS:** creator sees; `user` / `group` / `all` recipients see; non-recipient
  blocked; trip child visible via container share; non-recipient cannot see an
  unshared trip child; `assigned` recipient can `complete_event`, an
  `awareness` recipient cannot.
- **Services:** default applied / overridden / private at create; `adoptShare`
  moves an item inbox→agenda; `unadoptShare` reverses it; `shareTrip` writes
  exactly one row and children surface in the group view.
- **MCP parity:** each new tool resolves in `ToolSearch` (i.e. exists in the
  edge server, not just `mcp/src/index.ts`).

## Out of scope / deferred

- Dropping the old junction tables + `shared_with_friends` enum — a later,
  separate migration after one read-dormant release.
- Per-share audit history.
- Per-column edit permissions for assignees beyond completion.
- Tier-0 cross-user sharing (Tier 0 stays single-user).
