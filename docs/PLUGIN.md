# Plannen plugin — scope and Claude Desktop

## Scope: user vs project

By default `npx plannen init` installs the plugin at **user scope** — it loads in every Claude Code session you start. Verify with `claude plugin list`.

User scope is convenient but ties to the repo's absolute path. If you move or delete the repo, a user-scope install breaks.

To restrict the plugin to this repo:

```bash
claude plugin uninstall plannen
claude plugin marketplace remove plannen
claude plugin marketplace add ./ --scope project
claude plugin install plannen@plannen --scope project
```

Project-scope settings live in `.claude/settings.json` (committed). User-scope settings live in `~/.claude/settings.json` and reference the repo by absolute path.

**Trade-offs:**

- **User scope (default):** slash commands always available, even in unrelated projects. MCP server runs in every session.
- **Project scope:** plugin only activates inside this repo. Cleaner separation, but requires re-installing for each fresh clone.

## Claude Desktop

Claude Desktop doesn't support plugins, but it can talk to the MCP server. Register once:

```bash
claude mcp add plannen -s user -- node "$(pwd)/mcp/dist/index.js"
```

This writes to `~/.claude.json`, which Claude Desktop reads on launch. Credentials come from `<repo-root>/.env` automatically (the MCP server loads it via dotenv) — no `-e` flags needed. Restart Claude Desktop to pick up the registration.

To remove: `claude mcp remove plannen -s user`.
