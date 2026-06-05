#!/usr/bin/env bash
# Stop the Tier 0 embedded Postgres.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/lib/plannen-pg.mjs" stop
