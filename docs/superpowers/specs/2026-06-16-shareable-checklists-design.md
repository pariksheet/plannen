# Shareable Checklists — design

**Date:** 2026-06-16
**Status:** Approved (brainstorm)

## Problem

Plannen has no way to hold a **list of items** — things to pack, things to buy,
things to bring — that is *not* an agenda commitment. A packing-list line like
"swimming clothes", "sunscreen", "socks" is not a todo: it has no date, it is not
a unit of attention, and it must never surface in the daily briefing,
`list_events`, the calendar, gcal sync, or watch checks. The user needs to build
such lists, tick items off, and **share them with family members / groups** so
several people can pack or shop against the same list together.

The #40 trip-container work *assumed* packing lists would be todos-in-a-container
(the `list_label` "Packing / To-do / Shopping" presets). This design deliberately
**overrides that assumption**: a checklist item is a genuinely lighter entity than
a todo, and forcing it through `event_kind='todo'` would drag in the required
`start_date`, the event status machine, and agenda visibility — exactly what the
user does not want.

## Goal

A **checklist** primitive: a titled list of lean, checkable **items** that is

- **invisible to the agenda by construction** (its own tables; no briefing /
  event / calendar / gcal / watch query ever reads them),
- optionally **attached to a trip container** (packing for *this* trip) or
  **standalone** (a shopping list, a generic "stuff to bring"),
- **fully collaborative** when shared: anyone who can see a list can check items
  and add items, and every check records **who** ticked it.

## Scope (v1)

In scope:

- Two new tables: `checklists` and `checklist_items` (lean: text + checkbox +
  position; no date, no status, no recurrence).
- One-shot **create-and-fill** ("packing list: tent, stove, mat" → list + 3
  items in a single MCP call).
- Optional attach to a trip container via a nullable `event_id`.
- Sharing with **connected users and friend groups**, reusing the existing
  event/story sharing pattern. Fully collaborative writes (check + add) for
  anyone who can see the list; `checked_by` stamped on every check.
- A web/PWA `/checklists` view (list-of-lists with progress, tap-to-check,
  inline add-item, share control) and a checklist panel on an attached trip's
  page.

Explicitly out of scope (deferred — none block the core; each is a cheap
additive follow-up):

- **Per-item assignment** to a person (`assigned_to`) — "Milo packs his own bag".
  A nullable column we add when it becomes real.
- **Sections / sub-headings** within one list (Clothes / Toiletries / Documents).
  v1 is a flat list per the "lean" steer.
- **Templates / copy-last-trip's-list** — the obvious reuse win, deferred until
  the basics work.
- Any change to the recurrence/scheduling engine (checklists are not scheduled).

## Data model

Two new tables in the `plannen` schema (additive timestamped migration under
`supabase/migrations/`; the Tier 0 overlay is unaffected — no `auth.*` /
`storage.*` dependencies beyond `created_by`/`auth.uid()` already stubbed):

```
plannen.checklists
  id            uuid       pk default gen_random_uuid()
  title         text       not null
  event_id      uuid       null  REFERENCES plannen.events(id) ON DELETE SET NULL
  created_by    uuid       not null          -- owner (auth.uid())
  created_at    timestamptz not null default now()
  updated_at    timestamptz not null default now()
  -- index: idx_checklists_event_id (event_id), idx_checklists_created_by (created_by)

plannen.checklist_items
  id            uuid       pk default gen_random_uuid()
  checklist_id  uuid       not null REFERENCES plannen.checklists(id) ON DELETE CASCADE
  text          text       not null
  checked_at    timestamptz null              -- NULL = unchecked
  checked_by    uuid       null               -- who ticked it (no FK; app-resolved, like assigned_to/subject_id)
  position      int        not null default 0  -- manual ordering within the list
  created_at    timestamptz not null default now()
  -- index: idx_checklist_items_checklist_id (checklist_id, position)
```

Sharing junctions, mirroring the existing `event_shared_with_groups` /
`story_shared_with_groups` precedent (`20260520130000`):

```
plannen.checklist_shared_with_users
  checklist_id  uuid REFERENCES plannen.checklists(id) ON DELETE CASCADE
  user_id       uuid
  created_at    timestamptz not null default now()
  primary key (checklist_id, user_id)

plannen.checklist_shared_with_groups
  checklist_id  uuid REFERENCES plannen.checklists(id) ON DELETE CASCADE
  group_id      uuid REFERENCES plannen.friend_groups(id) ON DELETE CASCADE
  created_at    timestamptz not null default now()
  primary key (checklist_id, group_id)
```

Rules:

- **`event_id` ON DELETE SET NULL.** Detaching from a deleted trip must not
  destroy the list — a standalone shopping list outlives any trip it was linked
  to. When set, it must reference an `event_kind='container'` row owned by the
  same user (validated in the MCP handler).
- **`checklist_id` ON DELETE CASCADE.** Items have no meaning without their list
  (unlike container→todos, which are `SET NULL`). Deleting a checklist deletes
  its items.
- **`checked_by` has no FK** — same app-resolved convention as `assigned_to` /
  `subject_id`, so it can point at a connected user without a hard dependency.
- **No engine change.** Checklists are not recurring and items are dateless, so
  the byte-identical 3-runtime engine (`mcp/src/{practices,scheduling}.ts`, the
  Deno edge copies, `src/utils/scheduling.ts`) is untouched;
  `check-engine-parity.mjs` stays green without edits.

### RLS

Mirror the event-visibility pattern (helper functions in
`00000000000000_initial_schema.sql:304-330`). A checklist row is **visible** to a
user when:

- `created_by = auth.uid()`, OR
- the user is in `checklist_shared_with_users`, OR
- the user is a member of a group in `checklist_shared_with_groups`.

Because the list is **fully collaborative**, the same visibility predicate gates
**writes** to `checklist_items` (insert/update/delete) and inserts into
`checklist_items` for that list — anyone who can see a list can check and add
items. Editing the `checklists` row itself (title, sharing, attach) and deleting
the list are **owner-only** (`created_by = auth.uid()`). Add a
`checklist_can_access(p_checklist_id uuid)` SQL helper to express the visibility
predicate once and reuse it across the item policies.

## MCP tools

All tools land in **both** servers and pass `scripts/check-mcp-parity.mjs`:
`mcp/src/index.ts` (Tier 0 stdio) and a new
`supabase/functions/mcp/tools/checklists.ts` `ToolModule` registered in
`supabase/functions/mcp/index.ts`'s `TOOLS` array (Tier 1/2 edge — the one Claude
Code talks to). Edit the `mcp/src` canonical first, then mirror.

- **`create_checklist({ title, event_id?, items?: string[] })`** — creates the
  list and, if `items` is given, bulk-inserts them with sequential `position`.
  The one-shot create-and-fill ergonomic. Validates `event_id` (container, same
  owner) when present. Returns the list with its items.
- **`add_checklist_items({ checklist_id, items: string[] })`** — append items
  (positions continue after the current max). Allowed for anyone who can access
  the list.
- **`check_item({ item_id })`** / **`uncheck_item({ item_id })`** — set/clear
  `checked_at` + `checked_by = ctx.userId`. Allowed for anyone who can access the
  parent list.
- **`list_checklists({ event_id? })`** — every checklist the caller can see,
  each with `{ done, total }` progress. Optional `event_id` filter returns the
  lists attached to one trip.
- **`get_checklist({ checklist_id })`** — the list plus its items (ordered by
  `position`), each item including `checked_at` / `checked_by`.
- **`share_checklist({ checklist_id, user_ids?, group_ids? })`** — owner-only;
  upserts into the sharing junctions. Empty arrays are a no-op (not a clear).
- **`update_item({ item_id, text })`** — edit item text (accessor-allowed).
- **`delete_item({ item_id })`** — accessor-allowed.
- **`delete_checklist({ checklist_id })`** — owner-only; cascades items.

`transcribe_memory`-style local-only exemptions do not apply — every tool runs in
the edge function, so none go in the parity `LOCAL_ONLY` allowlist.

## Web / UI

- **Types** (`src/types/`): add `Checklist` and `ChecklistItem` interfaces.
- **Route `/checklists`** — list-of-lists, each row showing title, attached-trip
  chip (if any), and a progress bar (`done/total`). "New checklist" entry point.
- **Checklist detail** — items with tap-to-check (optimistic toggle), inline
  "add item" input, manual reorder is optional (positions exist; drag can come
  later), and a share control (pick users / friend groups). Each checked item
  shows `checked_by` as a small avatar/initial + relative time.
- **Trip integration** — when a checklist has an `event_id`, render a compact
  panel on that trip/container's detail page ("Packing — 4/11"), linking to the
  full list. Reuses the trip detail panel introduced in #40.

## Edge cases

- **Attached trip deleted** → checklist survives with `event_id = NULL` (SET
  NULL); it simply becomes standalone.
- **Item checked by a user who later loses access** (removed from a shared
  group) → `checked_by` is a plain uuid, so the stamp persists; the UI resolves
  it to a name when possible and falls back to a neutral label otherwise.
- **Tier 0 (single user)** → sharing targets resolve to an audience of one; the
  schema and tools are identical, collaboration is simply inert.
- **Empty `items`/`user_ids`/`group_ids`** → no-op, never a destructive clear.
- **Concurrent check of the same item** → last write wins on `checked_by`; an
  already-checked item being checked again just re-stamps (idempotent enough).
- **`event_id` pointing at a non-container or another user's event** → rejected
  in the handler.

## Migration / safety

- Forward-only additive migration under `supabase/migrations/`; apply via
  `npx plannen migrate` on every active profile. **Back up first**
  (`bash scripts/export-seed.sh` for Tier 1, or tar `~/.plannen/pgdata` +
  `~/.plannen/photos` for Tier 0). Never `supabase db reset`.
- Deploy the edge function after tool changes (`supabase functions deploy mcp
  --project-ref <ref>` for cloud, or restart `npx plannen up` for Tier 1).
- Rerun `npm run check:parity` (MCP + engine) and `npm run test:cli`.

## Testing

- Migration applies cleanly on a fresh DB and on a populated one; CASCADE and
  SET NULL behave as specified.
- `create_checklist` with `items` → list + N items at sequential positions,
  returned in order.
- `create_checklist` with a valid container `event_id` → attaches; with a
  non-container / foreign `event_id` → rejected.
- `add_checklist_items` appends after current max position.
- `check_item` stamps `checked_at` + `checked_by`; `uncheck_item` clears both;
  `list_checklists` progress reflects the change.
- A checklist item **never** appears in `list_events`, `get_briefing_context`,
  the calendar, gcal candidates, or the watch queue (explicit negative test).
- Sharing: a shared user/group member can `get_checklist`, `check_item`, and
  `add_checklist_items`; a non-shared user cannot (RLS denies). `share_checklist`
  and `delete_checklist` are owner-only.
- Deleting a checklist cascades its items; deleting an attached trip leaves the
  checklist with `event_id = NULL`.
- `scripts/check-mcp-parity.mjs`, `npm run check:parity`, and `npm run test:cli`
  green.
