#!/usr/bin/env bash
# Deploy the Plannen web app to Vercel.
#
#   bash scripts/vercel-deploy.sh
#
# Preconditions:
#   - You're on Tier 2 (`bash scripts/bootstrap.sh --tier 2` already done).
#   - `vercel` CLI installed and `vercel login` complete.
#   - Run `vercel link` once before this script (interactive: picks your
#     team/scope and project name). The repo's .vercel/ dir persists the
#     link for subsequent deploys.
#
# What it does:
#   1. Verifies vercel CLI + login.
#   2. Pushes VITE_* env vars from .env into the linked Vercel project
#      (production target). Existing vars are removed + re-added to stay
#      current.
#   3. Triggers `vercel --prod` and prints the deployment URL.
#   4. Prints a post-deploy checklist (Supabase Auth Site URL update —
#      one-time, must be done in the dashboard).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }

if [ ! -f .env ]; then
  red "no .env found — run bootstrap first"
  exit 1
fi

TIER=$(grep -E '^PLANNEN_TIER=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
if [ "$TIER" != "2" ]; then
  red "PLANNEN_TIER=$TIER; Vercel deploy is Tier 2 only"
  red "Run: bash scripts/bootstrap.sh --tier 2 ..."
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  red "vercel CLI not found"
  dim "Install: npm i -g vercel"
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  red "vercel is not logged in — run: vercel login"
  exit 1
fi

if [ ! -d .vercel ]; then
  red "vercel project not linked yet"
  dim "Run once (interactive): vercel link"
  dim "Then re-run: bash scripts/vercel-deploy.sh"
  exit 1
fi

node "$SCRIPT_DIR/lib/vercel-deploy.mjs"

# Read the cloud Supabase URL so the post-deploy checklist can point the user
# at the right Auth settings page.
SUPABASE_URL=$(grep -E '^SUPABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)
PROJECT_REF=$(grep -E '^SUPABASE_PROJECT_REF=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)

cat <<EOF

──────────────────────────────────────────────────────────────────
$(green "Post-deploy checklist") (the parts the CLI can't safely automate)
──────────────────────────────────────────────────────────────────

1. Update Supabase Auth Site URL + Redirect URLs to the Vercel domain.

   Go to:
     https://supabase.com/dashboard/project/${PROJECT_REF}/auth/url-configuration

   • Site URL:          your-vercel-domain  (the URL printed above)
   • Additional Redirect URLs: add the same URL with /** suffix, e.g.
                               https://plannen.vercel.app/**

   Without this, magic-link emails will still redirect to localhost.

2. (Optional) Configure a custom domain in Vercel → Project Settings →
   Domains. If you do, repeat step 1 with the custom domain too.

3. Test the flow: open your Vercel URL, request a magic link with the
   email you bootstrapped with, click the link from the email.

──────────────────────────────────────────────────────────────────
EOF
