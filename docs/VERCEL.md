# Deploying Plannen to Vercel (cloud_sb)

After `npx plannen init --mode=cloud_sb` finishes, you can deploy the web app to Vercel for any-browser access.

## One-time setup

```bash
npm i -g vercel
vercel login
vercel link        # interactive — pick scope and project name
```

## Deploy

```bash
npx plannen deploy
```

Pushes the `VITE_*` env vars from `.env` into the Vercel project (production target) and runs `vercel --prod`. Re-runs overwrite existing env values, so it's safe after each cloud config change. Prints the deployed URL and writes `PLANNEN_WEB_URL=<stable-alias>` back to `.env`.

(If `.vercel/` doesn't exist, the command runs `vercel link --yes` automatically.)

## Post-deploy checklist (manual, one-time)

- **Google OAuth callback** — if you use Google Calendar / Photos integration, add `https://<your-ref>.supabase.co/functions/v1/google-oauth-callback` to your Google Cloud OAuth client's authorised redirect URIs.
- **Custom SMTP** — if you want real magic-link emails (not Supabase's rate-limited default), configure a provider in Supabase Auth → SMTP settings.
- **Custom domain** — set it up in Vercel → Project Settings → Domains, then re-run `npx plannen init --mode=cloud_sb` so the Auth Site URL + Redirect URLs are updated to match.

Auth Site URL and Redirect URLs are wired automatically by `init` — no manual Supabase dashboard steps needed for the default Vercel URL.

The full design rationale is in [`superpowers/specs/2026-05-16-tier-2-vercel-hosting-design.md`](superpowers/specs/2026-05-16-tier-2-vercel-hosting-design.md).
