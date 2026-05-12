# Plannen — Claude Code plugin

Bundles the MCP server, six workflow skills, and seven slash commands so any Claude Code session in the Plannen repo gets the full workflow surface — no per-machine `.mcp.json` editing, no `CLAUDE.md` archaeology.

## Install

From the repo root, run the one-shot bootstrap first — it does the npm install, supabase start, migrations, auth user, env files, functions-serve, and offers to install the plugin at the end:

```
bash scripts/bootstrap.sh
```

If you only want the plugin (the rest is already set up), install it directly with Claude Code:

```
/plugin install ./plugin
```

The plugin registers an MCP server named `plannen` that runs `mcp/dist/index.js` and self-loads `<repo-root>/.env` for its config (no env block in the manifest). After install, run `/plannen-doctor` to verify everything is wired up.

> **If you previously ran `scripts/install-plannen-command.sh`** (the legacy installer): remove the stale `~/.claude/commands/plannen.md` file and run `claude mcp remove plannen -s user` before installing the plugin. The plugin replaces both surfaces.

## Skills

| Skill | Triggers on |
|---|---|
| `plannen-core` | Always-on. DB-migration safety, profile extraction, event-creation intent gate, source-analysis auto-trigger. |
| `plannen-stories` | "Write a story", "make a story about" a past event or trip. |
| `plannen-photos` | "Find / organise / scan / add photos" for an event. |
| `plannen-discovery` | Discovery queries: "find me a sailing course", "any summer camps for kids in Belgium". |
| `plannen-watches` | "Check my watched events" (manual). Future cloud routines will also call this. |
| `plannen-sources` | "Analyse my sources" (manual bulk source indexing). |

## Slash commands

| Command | Args |
|---|---|
| `/plannen-setup` | — |
| `/plannen-doctor` | — |
| `/plannen-write-story` | `[event or date range]` |
| `/plannen-organise-photos` | `[event]` |
| `/plannen-discover` | `<query>` |
| `/plannen-check-watches` | — |
| `/plannen-backup` | — |

Each slash command is a thin wrapper that triggers the matching skill — they exist for discoverability (typing `/plannen-` shows the available verbs), not because the natural-language path is broken.

## License

[AGPL-3.0](../LICENSE).
