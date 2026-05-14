# Plannen Kitchen Plugin — Design

**Date:** 2026-05-14
**Status:** Design approved; pending spec review and implementation plan
**Branch:** feat/plannen-schema

## Context

Plannen today is a family-operations app: events, family members, stories, photos, watches, sources. Weekly household operations — groceries, meal planning, pantry — sit outside it. The user does the weekly grocery run from a WhatsApp list sent by his wife, splits items across a primary supermarket plus a bakery and a local shop, walks back-and-forth inside the supermarket because the list isn't aisle-sorted, and routinely forgets which items he just bought when planning meals. Plannen already owns the schedule data that should inform the list (school days, school holidays, trips, parties) but does nothing with it.

This document specifies **`plannen-kitchen`**: a separate Claude Code plugin, opt-in, that adds shopping-list, pantry, and meal-plan reasoning to the Plannen ecosystem. It is the first non-core plugin in Plannen's history, so it also establishes the pattern for any future Plannen plugin (finance, school admin, etc.) — without building a generic plugin framework.

## Goals & non-goals

### Goals

- A user who already runs Plannen can install one extra plugin (`plannen-kitchen`) and get: a weekly grocery list parsed from arbitrary input (pasted WhatsApp text, photo of a handwritten list, dictation), a mobile-friendly in-store check-off view, and Claude-driven pantry and meal-plan reasoning that consumes Plannen's existing calendar.
- The kitchen plugin is a **sibling** of the Plannen plugin — own schema (`kitchen.*`), own MCP server, own Claude Code plugin folder, own UI files. Plannen core does not know about kitchen.
- The pattern this plugin uses (separate schema in same Supabase, separate MCP server, own plugin folder, UI dropped into a generic slot in the Plannen web app) is reusable for any future Plannen plugin.
- Claude does all parsing/matching/reasoning. The kitchen MCP exposes only structured operations on a knowledge graph (CRUD + queries). No "parse this image" or "suggest meals" tools.

### Non-goals

- A generic plugin framework. The web-app slot is ~30 lines of glue. There is no manifest spec, no plugin registry, no lifecycle hooks. If a third Plannen plugin ships, we revisit whether to formalise.
- Two-user (wife) workflow. Plannen is single-user local-only. The wife continues to send the list via WhatsApp; the user is the bridge into Plannen. A future "shareable list view" is out of scope.
- Consumption tracking ("we used up the milk"). Pantry is a derived view over recently-purchased items with a time window. Real inventory management is out of scope.
- Recipe management. Meal-plan reasoning is Claude reasoning over pantry + calendar; recipes (as structured data) are not stored.
- Aisle taxonomy / store-layout database. Aisle is free-text per item. Claude learns from history via `get_item_history`.
- Cross-language canonicalisation. If the wife writes "dudh" one week and "milk" another, they remain separate strings; Claude decides whether to unify when the user asks.
- Push notifications, voice activation, barcode scanning, store APIs. None of these in v1.

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Packaging unit | Separate Claude Code plugin (`plannen-kitchen`) | Add tools/tables directly to `plannen` plugin (first-class feature); build a generic plugin framework with manifests/registry. |
| Install model | Opt-in via `bootstrap.sh --plugin plannen-kitchen` (or `--plugin all`). Each plugin self-installs (plugin + MCP + migrations) via its own `install.sh`. | Bundled with core Plannen always; bundled with a runtime toggle. |
| Schema isolation | Own Postgres schema `kitchen.*` in the shared local Supabase. | Separate Supabase instance per plugin (rejected — RAM cost); tables in `plannen.*` schema (rejected — boundary blur). |
| MCP isolation | Own MCP server process exposing `mcp__kitchen__*` tools. | Add tools to existing Plannen MCP (rejected — surface bloat); shared MCP with per-plugin namespacing in one process (rejected — couples deploy). |
| Brain location | Claude does parsing/matching/suggestion via skills; kitchen MCP is pure CRUD/query. | Pre-built parsers in kitchen MCP (rejected — duplicates Claude's job). |
| UI integration | Plannen web app gains a generic `src/plugins/` slot (Vite `import.meta.glob`). Kitchen drops one symlinked file into that slot. Plannen core has no kitchen-specific code. | Standalone Vite app on a second port (rejected — bookmark/UX cost); hardcoded `/kitchen` route in Plannen web app (rejected — couples core to kitchen). |
| v1 UI scope | One mobile-first page (`/kitchen/shop`): in-store check-off only. | Multi-page UI (list editor, pantry browser, meal-plan view) — all stay as Claude conversation flows for v1. |
| Cross-plugin data access | Kitchen skills call existing Plannen MCP tools (`mcp__plannen__list_events`, etc.). No direct kitchen→plannen schema joins. | Direct SQL joins across schemas (rejected — bypasses the plugin boundary); a "shared data" view layer (rejected — premature). |

## Repository layout

```
plannen/                              ← existing repo root
├── src/                              ← Plannen web app (mostly unchanged)
│   └── plugins/                      ← NEW — generic plugin UI slot, empty by default
├── supabase/migrations/              ← Plannen migrations (plannen.* schema, unchanged)
├── mcp/                              ← Plannen MCP server (unchanged)
├── plugin/                           ← Plannen Claude Code plugin (unchanged)
│
├── plugins/                          ← NEW — sibling plugins live here
│   └── plannen-kitchen/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── skills/
│       │   ├── kitchen-shop.md
│       │   ├── kitchen-pantry.md
│       │   └── kitchen-meal-plan.md
│       ├── commands/
│       │   ├── kitchen-list.md       ← `/kitchen-list` (paste-and-parse helper)
│       │   └── kitchen-shop.md       ← `/kitchen-shop` (open the in-store view)
│       ├── mcp/
│       │   ├── src/index.ts
│       │   ├── package.json
│       │   └── tsconfig.json
│       ├── supabase/migrations/      ← kitchen.* schema migrations
│       ├── web/
│       │   └── kitchen.tsx           ← exports { label, route, Component }
│       ├── install.sh                ← installs plugin + builds MCP + runs migrations + symlinks web
│       ├── uninstall.sh              ← symmetric removal
│       └── README.md
│
├── scripts/
│   └── bootstrap.sh                  ← gains --plugin flag (loops over plugins/*/install.sh)
└── ...
```

### Why `plugins/` (not `extensions/`)

We use **"plugin"** consistently. Plannen itself is a Claude Code plugin (`./plugin/`). Kitchen is another Claude Code plugin (`./plugins/plannen-kitchen/`). "Extension" was rejected as a redundant second concept; "agent" was rejected because agents are autonomous executors (a separate axis from packaging).

The directory inside Plannen's web app (`src/plugins/`) is just the slot where plugins drop their UI files. Same word, same concept.

## Data model

A single schema, `kitchen`, with three tables. Pantry is a view, not a table.

```sql
-- kitchen.stores
create table kitchen.stores (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                            -- "Carrefour Vilvoorde", "Bakker Pieters", "Local Shop Schaerbeek"
  type         text not null check (type in ('supermarket','bakery','local','online','other')),
  notes        text,
  created_at   timestamptz not null default now()
);

-- kitchen.lists
create table kitchen.lists (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                            -- "Week of 2026-05-14"
  week_of      date,                                     -- nullable, for non-weekly lists
  status       text not null default 'active'
                 check (status in ('active','completed','archived')),
  notes        text,
  created_at   timestamptz not null default now()
);

-- kitchen.items
create table kitchen.items (
  id           uuid primary key default gen_random_uuid(),
  list_id      uuid not null references kitchen.lists(id) on delete cascade,
  name         text not null,                            -- raw, multilingual, as written
  qty          text,                                     -- free-text: "2 kg", "1 packet", "few"
  store_id     uuid references kitchen.stores(id) on delete set null,
  aisle        text,                                     -- free-text: "aisle 3", "fresh produce"
  status       text not null default 'pending'
                 check (status in ('pending','picked','skipped')),
  picked_at    timestamptz,
  notes        text,
  created_at   timestamptz not null default now()
);

-- kitchen.pantry (view)
create view kitchen.pantry as
  select id, name, qty, store_id, picked_at,
         (now() - picked_at)::interval as age
  from kitchen.items
  where status = 'picked' and picked_at is not null
  order by picked_at desc;

-- Indexes
create index items_list_id_status on kitchen.items(list_id, status);
create index items_name_picked_at on kitchen.items(name, picked_at desc) where status = 'picked';
create index items_picked_at on kitchen.items(picked_at desc) where status = 'picked';
```

Notes on shape:

- `name` is raw text. Claude is responsible for normalisation when it matters (e.g. `get_item_history` matches on lower(name)).
- `qty` and `aisle` are deliberately free-text. Structuring them adds zero value for v1 and forces Claude to lose information.
- `picked_at` is the single source of truth for the pantry view. No separate `pantry` table; no separate write path.
- RLS: not needed (Plannen is single-user local; same posture as `plannen.*` schema).

## MCP tool surface

The kitchen MCP server exposes ~10 tools. All are structured CRUD/query — no parsing, no AI-side reasoning.

| Tool | Purpose | Returns |
|---|---|---|
| `create_list(name, week_of?, notes?)` | New shopping list. | `{id, name, week_of, status}` |
| `list_lists(status?, limit?)` | Recent lists, defaults to 10. | `[{id, name, week_of, status, item_count, picked_count}]` |
| `update_list(list_id, name?, status?, notes?)` | Edit or archive. | updated row |
| `add_item(list_id, name, qty?, store_id?, aisle?, notes?)` | Add one item. Claude calls many times when parsing a pasted list. | `{id, ...}` |
| `list_items(list_id, status?)` | Items in a list, filterable by status. | `[{id, name, qty, store_id, store_name, aisle, status, picked_at}]` |
| `update_item(item_id, name?, qty?, store_id?, aisle?, notes?)` | Edit item details (pre-pickup). | updated row |
| `check_off_item(item_id)` | Mark picked. Sets `status='picked'` and `picked_at=now()`. | updated row |
| `delete_item(item_id)` | Remove from list. | `{ok}` |
| `get_item_history(name, limit?)` | Return last N times this item (case-insensitive name match) was bought, with store and aisle. | `[{name, store_name, aisle, picked_at, list_name}]` |
| `list_stores(type?)` | Stores, filterable by type. | `[{id, name, type, notes}]` |
| `add_store(name, type, notes?)` / `update_store` / `delete_store` | Store CRUD. | row |
| `list_pantry(days?)` | Read the pantry view. Default `days=14`. | `[{id, name, qty, store_name, picked_at, age}]` |

**Defaults that matter (echoing the Plannen lesson):** `list_lists` and `list_items` default to a limit but never silently truncate without warning — the response includes `truncated: true` when the limit was hit, so Claude knows to widen.

**What is NOT in the MCP:**

- `parse_grocery_list(text)` — Claude does this in conversation, calling `add_item` once per parsed item.
- `suggest_meals(...)` — meal planning lives in the `kitchen-meal-plan.md` skill; the skill instructs Claude to call `list_pantry` and `mcp__plannen__list_events` and reason itself.
- `match_item_fuzzy(text)` — Claude does string matching using `get_item_history` results.

## UI surface

### The plugin slot in Plannen's web app

```ts
// plannen/src/plugins/index.ts (NEW, ~30 lines)
const modules = import.meta.glob('./*.tsx', { eager: true });

export type PluginEntry = {
  label: string;            // nav item text
  route: string;            // mounting path, e.g. "/kitchen"
  Component: React.ComponentType;
};

export const plugins: PluginEntry[] = Object.values(modules)
  .map((m: any) => m.default)
  .filter(Boolean);
```

The Plannen router and nav iterate `plugins[]`. If the directory is empty (no plugins installed), no nav items, no extra routes. Plannen core has no knowledge of "kitchen" — only of the slot.

### The kitchen UI file

```tsx
// plugins/plannen-kitchen/web/kitchen.tsx
import ShopView from './ShopView';

export default {
  label: 'Kitchen',
  route: '/kitchen',
  Component: ShopView,
};
```

`install.sh` creates a symlink: `plannen/src/plugins/kitchen.tsx` → `plugins/plannen-kitchen/web/kitchen.tsx`. Uninstall removes the symlink.

### v1 page: in-store shop view

`/kitchen` renders **one** mobile-first page:

```
┌──────────────────────────────────┐
│ Week of May 14    12 / 18 picked │
├──────────────────────────────────┤
│ ▼ Carrefour Vilvoorde (8 left)   │
│   □ Milk  1L · aisle: dairy      │
│   □ Paneer  · aisle: fresh       │
│   ✓ Cumin  100g · aisle: spices  │
│   ...                            │
│ ▼ Bakker Pieters (2 left)        │
│   □ Wholegrain bread             │
│   □ Croissants  4                │
│ ▼ Local Shop (1 left)            │
│   □ Coriander  bunch             │
│ ▼ Unassigned (0 left)            │
└──────────────────────────────────┘
```

Behaviour:

- Tap a row → row gets a check, item moves to `status='picked'`, count updates. Optimistic update; Supabase JS client write in the background.
- Sort: by store group; within group, by `aisle` ascending then `name`.
- "Unassigned" group at the bottom for items with no `store_id`.
- No add-item button. Adding is a Claude conversation flow.
- No filters, no search. Lists are weekly and small.

Web access uses the existing Plannen Supabase JS client (anon key + user JWT) — the same path the rest of the Plannen web app already uses. MCP service-role access is for Claude only.

## Data flows

### Flow 1 — Intake (list arrives)

```
User              Claude                          Plannen MCP            Kitchen MCP            Supabase
 │                  │                                 │                      │                      │
 │ paste WhatsApp   │                                 │                      │                      │
 │ text / image     │                                 │                      │                      │
 │─────────────────▶│                                 │                      │                      │
 │                  │ parse items (vision/OCR/text)   │                      │                      │
 │                  │ detect language, expand abbrev. │                      │                      │
 │                  │                                                                               │
 │                  │ list_lists(status='active', limit=5)            ───────▶                      │
 │                  │ ◀──── [no current week list]                                                  │
 │                  │ create_list(name='Week of 2026-05-14',                                        │
 │                  │            week_of='2026-05-14')                ───────▶ insert lists         │
 │                  │ ◀──── {list_id}                                                               │
 │                  │ list_stores()                                   ───────▶                      │
 │                  │ ◀──── [3 stores]                                                              │
 │                  │ for each parsed item:                                                         │
 │                  │   get_item_history(name)                        ───────▶ query items          │
 │                  │   ◀──── [last store, aisle]                                                   │
 │                  │   add_item(list_id, name, qty, store_id, aisle) ───────▶ insert items         │
 │ ◀── "Added 18 items: 13 supermarket, 2 bakery, 3 local."                                         │
```

### Flow 2 — In-store check-off

```
User (phone)       /kitchen page                    Supabase
 │                  │                                 │
 │ tap "Milk"       │                                 │
 │─────────────────▶│ optimistic UI flip              │
 │                  │ update items set status='picked',
 │                  │   picked_at=now() where id=...  ───────▶
 │                  │ ◀──── ok                                  │
```

No Claude in this loop. The page hits Supabase directly with the user's session.

### Flow 3 — Pantry / meal-plan query (Claude conversation)

```
User           Claude                       Kitchen MCP        Plannen MCP        Supabase
 │              │                              │                  │                  │
 │ "Plan       │                              │                  │                  │
 │  dinners"   │                              │                  │                  │
 │────────────▶│ list_pantry(days=14)         ───────▶            │                  │
 │             │ ◀── [paneer, spinach, ...]                                          │
 │             │ list_events(from_date=today,                                        │
 │             │             to_date=today+7,                                        │
 │             │             limit=50)                ───────────▶                   │
 │             │ ◀── [school days, party Wed, trip Fri-Sun]                          │
 │             │ reason: 4 cooked dinners needed (Mon-Thu),                          │
 │             │         skip Fri-Sun, pantry has paneer + spinach                   │
 │ ◀── "Mon: palak paneer (uses both). Tue: ..."                                     │
```

The `kitchen-meal-plan.md` skill spells out this reasoning pattern so Claude follows it consistently.

## Install / uninstall

### `bootstrap.sh --plugin <name>`

`bootstrap.sh` gains a `--plugin` flag:

```bash
bash bootstrap.sh                              # core Plannen only
bash bootstrap.sh --plugin plannen-kitchen     # core + kitchen
bash bootstrap.sh --plugin all                 # core + every plugins/* directory
```

Internally: after the core setup, the script iterates the requested plugin names and runs `plugins/<name>/install.sh` for each.

### `plugins/plannen-kitchen/install.sh`

```bash
# 1. Build the MCP server (npm install + tsc)
# 2. Register the MCP with Claude Code (add to .mcp.json or /plugin install)
# 3. Apply migrations: supabase migration up (picks up kitchen/* migrations)
# 4. Symlink web/kitchen.tsx -> ../../src/plugins/kitchen.tsx
# 5. /plugin install ./plugins/plannen-kitchen
# 6. Print: "Open localhost:4321/kitchen on your phone."
```

### `uninstall.sh` (symmetric)

```bash
# 1. /plugin uninstall plannen-kitchen
# 2. Remove src/plugins/kitchen.tsx symlink
# 3. Unregister kitchen MCP
# 4. Optional flag --drop-schema: drop schema kitchen cascade
```

### Migrations

The kitchen plugin's migrations live in `plugins/plannen-kitchen/supabase/migrations/`. `install.sh` symlinks each migration into `plannen/supabase/migrations/` so the existing `supabase migration up` workflow picks them up. This keeps the forward-only rule intact (consistent with the project's hard rule against `supabase db reset`).

Naming: kitchen migrations are timestamped after the Plannen migrations they depend on. v1 has one migration: `20260514000000_kitchen_initial.sql`.

## Cross-plugin data access

Kitchen needs to read Plannen data (events, family members, locations). Two access paths exist; we use one and rule out the other.

| Path | Used? | Notes |
|---|---|---|
| Kitchen skill calls existing Plannen MCP tools (`mcp__plannen__list_events`, `list_family_members`, `list_locations`) | ✅ Yes | Goes through the same interface any caller would. No coupling. |
| Kitchen MCP server joins across schemas (`kitchen.items` JOIN `plannen.events`) | ❌ No | Bypasses the Plannen plugin's boundary. If Plannen ever moves to a separate database, kitchen would silently break. |

Kitchen skills explicitly reference Plannen tool names. If Plannen isn't installed, the user gets a clear error from Claude, not a confusing SQL failure.

## Open questions for spec review

1. **Item-name canonicalisation.** If history shows `dudh` (Marathi) and `milk` (English), `get_item_history('milk')` won't find `dudh`. Acceptable for v1 (user/Claude can correct), or should we add a `canonical_name` column? **Proposed: defer.**
2. **List rollover.** When a new week starts, do we copy unchecked items from last week into the new list? **Proposed: no automatic rollover in v1.** Claude can do this on request ("carry over what we missed").
3. **`week_of` semantics.** ISO-week start date (Monday) or user-chosen? **Proposed: Monday of the current ISO week, default; overridable by Claude when the user says otherwise.**
4. **Mobile auth.** Phone hitting `localhost:4321` works on home wifi only. Acceptable for v1 (Plannen is local-first). Cloud sync / remote access is a future tier concern.

## Backlog (post-v1)

- List rollover / template lists ("our standard weekly basics").
- Per-store layout map (aisle taxonomy) so within-store sort uses a learned order rather than free-text alpha sort.
- Consumption tracking and shopping suggestions ("you usually buy milk every 5 days, last bought 6 days ago").
- Shareable read-only list view for the wife (link with a one-time token).
- Inline UI for editing list / browsing pantry (only if conversation flow proves insufficient).
- Voice input on the in-store page (Web Speech API) for hands-free check-off.
- Photo input for handwritten list (already works via Claude, but a dedicated upload flow would be nicer than copy-paste).

## Testing

- **MCP tools.** Each tool has a unit test against a local Supabase using the existing pattern in `mcp/`.
- **Migrations.** Migration runs cleanly on a fresh Plannen install with kitchen plugin enabled. Verified by re-running `bootstrap.sh --plugin plannen-kitchen` on a clean clone.
- **Plugin install/uninstall.** Symmetric: after uninstall, no kitchen file in `src/plugins/`, no kitchen MCP in `.mcp.json`, no kitchen route in the running web app. Verified manually.
- **Web UI.** Manual on a real phone, in a real supermarket, on the first real list. The brief is "would the user actually use this in-store this Saturday" — if no, the v1 page failed.
- **Conversation flows.** Manual: paste a real WhatsApp list, verify Claude creates the right list + items + tags. Ask Claude pantry/meal-plan questions, verify reasoning uses `list_pantry` + `list_events`.

## Spec change log

- 2026-05-14: Initial draft.
