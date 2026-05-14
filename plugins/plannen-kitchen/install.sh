#!/usr/bin/env bash
# plannen-kitchen — installer.
#
# Run from repo root: bash plugins/plannen-kitchen/install.sh
# Or via bootstrap: bash scripts/bootstrap.sh --plugin plannen-kitchen

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

step()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

cd "$REPO_ROOT"

# ── 1. Build the MCP server ──────────────────────────────────────────────────
step "Building plannen-kitchen MCP"
(cd "$PLUGIN_DIR/mcp" && npm install --silent && npm run build --silent)
ok "MCP built at $PLUGIN_DIR/mcp/dist/index.js"

# ── 2. Symlink migrations into Plannen's supabase/migrations ─────────────────
step "Linking kitchen migrations into supabase/migrations"
for src in "$PLUGIN_DIR/supabase/migrations/"*.sql; do
  [ -e "$src" ] || continue
  base="$(basename "$src")"
  link="$REPO_ROOT/supabase/migrations/$base"
  if [ -L "$link" ]; then
    ok "  $base already linked"
  elif [ -e "$link" ]; then
    err "  $base exists in supabase/migrations/ but is not a symlink — refusing to overwrite"
    exit 1
  else
    ln -s "$src" "$link"
    ok "  linked $base"
  fi
done

# ── 3. Run migrations ────────────────────────────────────────────────────────
step "Applying migrations (supabase migration up)"
if supabase status >/dev/null 2>&1; then
  supabase migration up
  ok "Migrations applied"
else
  warn "supabase not running — start it (supabase start) then re-run this script"
fi

# ── 4. Symlink the web UI into src/plugins/ ──────────────────────────────────
step "Linking kitchen UI into src/plugins/"
link="$REPO_ROOT/src/plugins/kitchen.tsx"
src="$PLUGIN_DIR/web/kitchen.tsx"
if [ -L "$link" ]; then
  ok "  kitchen.tsx already linked"
elif [ -e "$link" ]; then
  err "  src/plugins/kitchen.tsx exists but is not a symlink — refusing to overwrite"
  exit 1
else
  ln -s "$src" "$link"
  ok "  linked kitchen.tsx"
fi

# ── 5. Register the plugin with Claude Code ──────────────────────────────────
step "Registering plugin with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude plugin install "$PLUGIN_DIR" || warn "claude plugin install failed — install manually with: /plugin install $PLUGIN_DIR"
  ok "Plugin registered"
else
  warn "claude CLI not on PATH — install manually with: /plugin install $PLUGIN_DIR"
fi

# ── 6. Done ──────────────────────────────────────────────────────────────────
printf '\n\033[1;32m✓\033[0m plannen-kitchen installed.\n\n'
printf 'Next:\n'
printf '  • Restart Claude Code (so the new plugin + MCP load)\n'
printf '  • Open http://localhost:4321/kitchen on your phone (same wifi)\n'
printf '  • Or type /kitchen-list and paste this week'"'"'s grocery list\n\n'
