#!/usr/bin/env bash
# Start local Plannen dev environment.
# Run this instead of `supabase start` directly — it patches Kong to add
# the bare /verify route that GoTrue uses in magic link emails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
KONG_CONFIG="$PROJECT_DIR/supabase/kong.yml"
CONTAINER="supabase_kong_plannen"

echo "==> Starting local Supabase…"
cd "$PROJECT_DIR"
supabase start

echo "==> Patching Kong: adding bare /verify route…"
# Write the config via stdin → in-container `tee` so the file is owned by the
# Kong user. `docker cp` preserves host UID, which causes the entrypoint's
# kong.yml regen on restart to fail with "permission denied" and traps the
# container in a restart loop.
docker exec -i "$CONTAINER" sh -c 'cat > /home/kong/kong.yml' < "$KONG_CONFIG"
docker exec "$CONTAINER" kong reload

echo ""
echo "==> Done. Start the dev server with: npm run dev"
echo "    Mailpit (email inbox): http://127.0.0.1:54324"
echo "    Studio:               http://127.0.0.1:54323"
