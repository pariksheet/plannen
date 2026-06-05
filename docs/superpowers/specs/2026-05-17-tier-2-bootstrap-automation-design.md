# Tier 2 — Bootstrap automation (Phase B.2.1)

**Date:** 2026-05-17
**Type:** UX / orchestration polish over the Tier 2 + Vercel flow
**Status:** Implemented on branch feat/tier-2-cloud-deploy.

## Problem

Phase B.1 + B.2 work end-to-end, but a first-time Tier 2 user still goes through ~10 manual steps:

1. Find the project ref in the Supabase dashboard URL.
2. Find the connection-pooler URL in Project Settings → Database → Connection string.
3. Run `bash scripts/bootstrap.sh --tier 2 --project-ref … --cloud-db-url …`.
4. Realise PostgREST doesn't expose the `plannen` schema → open dashboard → Data API → Exposed Schemas → add `plannen` → save.
5. Install + log into Vercel CLI.
6. `vercel link` (interactive).
7. `bash scripts/vercel-deploy.sh`.
8. Open Auth → URL Configuration → set Site URL.
9. Add the Vercel URL + `/**` to Additional Redirect URLs.
10. Optionally — set up Resend SMTP because the built-in mailer rate-limits at ~3 emails/hour.

Items 1, 2, 4, 8, 9 are pure dashboard-clicking that the Supabase Management API can do. Items 6, 7 can be folded into bootstrap. Items 5 and 10 stay manual (OAuth / third-party signup).

The result Phase B.2 already flagged as a follow-up: *"Future B.2.1 can automate"* (see [`./2026-05-16-tier-2-vercel-hosting-design.md`](./2026-05-16-tier-2-vercel-hosting-design.md)).

## Decision

Wire two new capabilities into the existing Tier 2 flow:

1. **Supabase Management API helper** (`scripts/lib/supabase-mgmt.mjs`) that uses the access token already cached at `~/.supabase/access-token` by `supabase login`. Exposes: `listProjects()`, `getDbPasswordHint(ref)`, `setExposedSchemas(ref, schemas)`, `updateAuthConfig(ref, { siteUrl, uriAllowList })`.
2. **Interactive project picker + Vercel offer** integrated into `scripts/bootstrap.sh --tier 2`.

After this lands, the happy path is:

```
$ bash scripts/bootstrap.sh --tier 2

  Select a Supabase project:
    1) plannen (abcd1234abcd1234abcd, eu-central-1)
    2) other-project (…)
    > 1

  DB password for plannen (postgres user): ****
  Running migration… ✓
  Exposing plannen schema via PostgREST… ✓
  Setting Auth Site URL to http://localhost:4321… ✓

  Deploy web app to Vercel now? [Y/n] y
  vercel link --yes  (project: plannen)… ✓
  Pushed 4 env vars… ✓
  Deployed: https://plannen.vercel.app
  Updating Auth Site URL → https://plannen.vercel.app … ✓

  Done. Sign in at https://plannen.vercel.app.
```

## Components

| File | Change |
|---|---|
| `scripts/lib/supabase-mgmt.mjs` *(new)* | Thin REST client over `https://api.supabase.com/v1`. Reads token from `~/.supabase/access-token` (override via `SUPABASE_ACCESS_TOKEN`). Pure functions + dep-injected `fetch`. |
| `scripts/lib/cloud-project-picker.mjs` *(new)* | Lists projects via `supabase-mgmt.listProjects()`, renders a numbered menu, returns `{ projectRef, region }`. Honors `--project-ref` flag (skips menu) for non-interactive CI. |
| `scripts/lib/cloud-db-url.mjs` *(new)* | Builds the pooler URL from `{ projectRef, region, password }` using the canonical `postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres` template. |
| `scripts/lib/migrate-tier1-to-tier2.mjs` | New step `expose-schemas` after `push-schema`: calls `supabase-mgmt.setExposedSchemas(ref, ['plannen', 'public', 'graphql_public'])`. Idempotent. New step `wire-auth` after `rewrite-config`: calls `updateAuthConfig` with `siteUrl = http://localhost:4321` and the localhost wildcard in the allow-list. Both are skipped (with a printed note) if `SUPABASE_ACCESS_TOKEN` isn't available. |
| `scripts/bootstrap.sh` | Tier 2 path: drop the requirement that `--project-ref` and `--cloud-db-url` be passed as flags. If absent in interactive mode, run the picker + prompt for password. Flags still work for CI. After successful migration, ask "Deploy to Vercel?" and (on yes) call `scripts/vercel-deploy.sh` inline. |
| `scripts/lib/vercel-deploy.mjs` | Add a `vercelLink({ yes: true, scope })` helper that runs `vercel link --yes` if `.vercel/` is missing. Add a post-deploy hook that calls `supabase-mgmt.updateAuthConfig` to set `siteUrl` to the deployed Vercel URL and add `<url>/**` to the allow-list (keeps the existing localhost entry). |
| `scripts/cloud-doctor.mjs` | Add two checks: (a) PostgREST exposes `plannen` (probe `/rest/v1/?schema=plannen`); (b) Auth `site_url` matches one of `{ localhost:4321, deployed Vercel URL }`. |
| `tests/scripts/supabase-mgmt.test.ts` *(new)* | Pure-function tests + a stubbed-fetch integration test for each public method. |
| `tests/scripts/cloud-project-picker.test.ts` *(new)* | Menu rendering + selection logic (no real I/O). |
| `tests/scripts/migrate-tier1-to-tier2.test.ts` | Add cases for `expose-schemas` + `wire-auth` steps, including the "no access token → skipped" path. |
| `README.md` | Replace the long flag-based Tier 2 invocation with the interactive one. Keep the flag form documented for CI. |

## UX details

- **Access token discovery.** Probe `process.env.SUPABASE_ACCESS_TOKEN` first, then `~/.supabase/access-token` (the file `supabase login` writes — a plain string, not JSON). If neither exists, fall back to printing the same dashboard links B.2 prints today and continue. Bootstrap doesn't fail just because Management API is unavailable.
- **Project picker.** Use `inquirer`-free single-line input (read from `/dev/tty`) — bootstrap is already shell-driven and we want to keep zero new dependencies in this path. Format: `N) <name> (<ref>, <region>)`.
- **DB password.** Use `read -s` (silent) in shell so the password doesn't echo. Don't persist it anywhere except in-memory for the pooler URL passed to the migration orchestrator. The orchestrator already doesn't write it to `.env`.
- **Vercel link non-interactive.** `vercel link --yes` uses the cwd folder name as the project name. If the user wants a different name, they can run `vercel link` manually first and skip the prompt. Document this.
- **Auth allow-list as a set.** When updating `uri_allow_list`, fetch the current list, union the new entry, dedupe, write back. Never replace.
- **Re-runs are idempotent.** `setExposedSchemas` with the same set is a no-op. `updateAuthConfig` with the same values is a no-op. Both endpoints are PATCH so partial updates are safe.

## Tradeoffs

**Token rotation.** The access token in `~/.supabase/access-token` can expire (≥1 year today, but Supabase reserves the right to shorten). Failure mode is a 401 mid-bootstrap. We catch this specifically and print `run \`supabase login\` again, then re-run bootstrap`. The orchestrator's progress file means re-runs resume from the failed step.

**One more credential surface.** B.2 deliberately avoided the Management API to keep auth boundaries simple (only `supabase` CLI talks to Supabase; only `vercel` CLI talks to Vercel). B.2.1 reuses the same token that `supabase login` already minted — we're not adding a credential, just using one path the CLI doesn't expose. Net auth complexity is the same.

**Interactive bootstrap on CI.** Bootstrap already supports `--non-interactive`. The picker honors `--project-ref` to skip selection, and password can come from `CLOUD_DB_PASSWORD` env. CI flow ends up: `bash scripts/bootstrap.sh --tier 2 --non-interactive --project-ref X --skip-vercel` with `CLOUD_DB_PASSWORD=…` in the env. No regression.

## Out of scope

- **Custom SMTP / Resend setup.** Third-party signup; not automatable. The post-deploy checklist mentions it.
- **Custom domain in Vercel.** Stays manual (DNS records belong to the user).
- **Rotating the Supabase access token.** If it's expired we surface a clean error, but minting a new one means re-running `supabase login` (browser OAuth).
- **`vercel login`.** Browser OAuth, can't be automated.
- **Removing `bootstrap.sh`'s `--cloud-db-url` flag entirely.** Keep it as an escape hatch for users who already have the full URL on hand.

## Migration / rollout

- Phase B.2.1 ships behind no flag — the new behaviour is the default. Old flag-based invocation still works.
- No DB schema changes. Forward-compatible with existing Tier 2 installs.
- Existing users on Tier 2 don't need to re-bootstrap; the new wire-auth + expose-schemas steps are safe to run against an already-migrated project as one-shots (`node scripts/lib/migrate-tier1-to-tier2.mjs` from the CLI entry, or via a future `scripts/cloud-wire.sh` if the demand exists).

## Pointers

- [`./2026-05-16-tier-2-cloud-deploy-design.md`](./2026-05-16-tier-2-cloud-deploy-design.md) — Phase B.1.
- [`./2026-05-16-tier-2-vercel-hosting-design.md`](./2026-05-16-tier-2-vercel-hosting-design.md) — Phase B.2 (this is the follow-up it flagged).
- Supabase Management API: `https://api.supabase.com/v1` — projects, postgrest/config, config/auth endpoints.
- Access token location: `~/.supabase/access-token` (written by `supabase login`).
