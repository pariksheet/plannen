#!/usr/bin/env bash
# Install Plannen plugin skills into ~/.claude/skills/ as symlinks so Claude
# Desktop (and Claude.ai) can load them. Re-runs are idempotent — each skill
# directory is wiped and re-symlinked, picking up any frontmatter changes.
#
# Note for Claude Code users: if you've installed the Plannen plugin via
# `claude plugin install`, Claude Code already loads these skills from the
# plugin path. Installing here as user skills would expose them twice — pick
# one path or the other.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/bootstrap-helpers.sh
. "$SCRIPT_DIR/lib/bootstrap-helpers.sh"

cd "$PROJECT_DIR"

SRC_DIR="$PROJECT_DIR/plugin/skills"
DEST_BASE="$HOME/.claude/skills"

if [ ! -d "$SRC_DIR" ]; then
  err "no plugin/skills directory at $SRC_DIR"
  exit 1
fi

mkdir -p "$DEST_BASE"

count=0
for src in "$SRC_DIR"/*.md; do
  [ -f "$src" ] || continue
  # Extract `name:` from YAML frontmatter; fall back to filename without .md.
  name=$(awk '
    /^---[[:space:]]*$/ { in_fm = !in_fm; next }
    in_fm && /^name:/ {
      sub(/^name:[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      print
      exit
    }
  ' "$src")
  if [ -z "$name" ]; then
    name=$(basename "$src" .md)
  fi

  dest_dir="$DEST_BASE/$name"
  dest_file="$dest_dir/SKILL.md"

  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"
  ln -s "$src" "$dest_file"
  ok "installed: $name → $dest_file"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  warn "no skills found in $SRC_DIR"
  exit 1
fi

dim "$count skill(s) installed at $DEST_BASE"
dim "Restart Claude Desktop to pick them up."
