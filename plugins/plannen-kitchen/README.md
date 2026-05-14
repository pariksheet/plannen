# plannen-kitchen

Weekly grocery, pantry, and meal-plan reasoning for [Plannen](../..).

A sibling Claude Code plugin that lives alongside the main Plannen plugin. Adds a `kitchen.*` schema, an MCP server, three skills, two slash commands, and one mobile-first web page.

## What it does

- **Parse a grocery list** pasted from WhatsApp text or an image of a handwritten list. Claude reads it, looks up where you usually buy each item, and structures it into a weekly list with store + aisle tags.
- **Check off items in-store** on your phone at `localhost:4321/kitchen`. Grouped by store; sorted by aisle. No more backtracking through the supermarket.
- **Pantry awareness.** Items you check off feed a `pantry` view (everything bought in the last 14 days). Ask Claude "what's in the pantry?" and you'll know.
- **Meal-plan reasoning** that consumes both the pantry and your Plannen calendar (school days, parties, trips), so suggestions skip days you're not eating at home and use ingredients you already bought.

## Install

From the repo root, after `bootstrap.sh` has set up the core Plannen app:

```bash
bash plugins/plannen-kitchen/install.sh
```

Or as part of bootstrap:

```bash
bash scripts/bootstrap.sh --plugin plannen-kitchen
```

The installer:
1. Builds the kitchen MCP server.
2. Symlinks the kitchen migrations into `supabase/migrations/`.
3. Runs `supabase migration up` (if Supabase is running).
4. Symlinks the kitchen UI into `src/plugins/kitchen.tsx`.
5. Registers the plugin with Claude Code.

Restart Claude Code afterwards so the new plugin loads.

## Usage

- `/kitchen-list` — paste this week's list (text or image). Claude parses + structures + populates this week's list.
- `/kitchen-shop` — opens (well, prints the URL for) the in-store page.
- Conversational: "what's in the pantry?", "plan dinners this week", "where did I buy paneer last time?"

## Uninstall

```bash
bash plugins/plannen-kitchen/uninstall.sh
```

Add `--drop-schema` if you want to drop `kitchen.*` and lose all data. Without that flag, the schema is preserved so reinstall keeps your history.

## Architecture

See `docs/superpowers/specs/2026-05-14-plannen-kitchen-plugin-design.md` in the parent repo for the full design.

## License

AGPL-3.0-only, same as Plannen.
