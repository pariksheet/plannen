#!/usr/bin/env bash
# plannen-kitchen — uninstaller.
#
# Usage:
#   bash plugins/plannen-kitchen/uninstall.sh
#   bash plugins/plannen-kitchen/uninstall.sh --drop-schema   # also drops kitchen.* tables

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

DROP_SCHEMA=0
for arg in "$@"; do
  case "$arg" in
    --drop-schema) DROP_SCHEMA=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

step()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }

cd "$REPO_ROOT"

# ── 1. Unregister plugin from Claude Code ────────────────────────────────────
step "Unregistering plugin from Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude plugin uninstall plannen-kitchen || warn "claude plugin uninstall failed (may not be registered)"
  ok "Plugin unregistered"
fi

# ── 2. Remove web UI symlink ─────────────────────────────────────────────────
step "Removing UI symlink"
link="$REPO_ROOT/src/plugins/kitchen.tsx"
if [ -L "$link" ]; then
  rm "$link"
  ok "Removed src/plugins/kitchen.tsx"
elif [ -e "$link" ]; then
  warn "src/plugins/kitchen.tsx exists but isn't a symlink — left in place"
else
  ok "No UI symlink to remove"
fi

# ── 3. Remove migration symlinks ─────────────────────────────────────────────
step "Removing migration symlinks"
for src in "$PLUGIN_DIR/supabase/migrations/"*.sql; do
  [ -e "$src" ] || continue
  base="$(basename "$src")"
  link="$REPO_ROOT/supabase/migrations/$base"
  if [ -L "$link" ]; then
    rm "$link"
    ok "  removed $base"
  fi
done

# ── 4. Optionally drop the schema ────────────────────────────────────────────
if [ "$DROP_SCHEMA" -eq 1 ]; then
  step "Dropping kitchen schema (--drop-schema)"
  if supabase status >/dev/null 2>&1; then
    psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "DROP SCHEMA IF EXISTS kitchen CASCADE;"
    ok "Schema dropped"
  else
    warn "supabase not running — start it and run: psql ... -c 'DROP SCHEMA kitchen CASCADE;'"
  fi
else
  warn "Schema kitchen.* left intact. Re-run with --drop-schema to drop it."
fi

ok "plannen-kitchen uninstalled."
