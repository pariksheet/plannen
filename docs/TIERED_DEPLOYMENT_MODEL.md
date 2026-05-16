# Tiered Deployment Model

Plannen runs in a small set of tiers. The choice is one axis: **where Postgres lives and which services around it Plannen ships vs. assumes.** Publishing / social-graph features are orthogonal — any tier can opt into them when they ship.

| Tier | Postgres | Auth | Storage | HTTP API (today's edge functions) | Who installs |
|---|---|---|---|---|---|
| **Tier 0 — Bundled** *(new starter, default)* | `embedded-postgres` binary started by Node, listens on local port | `auth.uid()` stub from session GUC; no login UI | Local filesystem under `~/.plannen/photos/`, served by the Phase 2 backend stub | Node backend process (`backend/`) on a local port | New users — runs with just Node 20+ |
| **Tier 1 — Local Supabase** *(today)* | Postgres in the Supabase Docker stack | Supabase Auth (GoTrue) magic-link | Supabase Storage with xattrs | Supabase Edge Functions (Deno) | Existing users — Docker + Supabase CLI |
| **Tier 2 — External Postgres** *(future)* | Any Postgres URL (Neon, hosted Supabase Cloud, self-hosted) | Tier-dependent | Tier-dependent | Backend stub points at the remote DB | Users wanting cloud storage |
| **Tier 3+ — Hosted Plannen** *(out of scope here)* | Managed | Managed | Managed | Managed | Future commercial offering |

**Cost ladder.** Tier 0 = free, no setup beyond Node. Tier 1 = free, requires Docker. Tier 2 = pay your hosting provider. Tier 3+ = pay Plannen.

**Default tier.** Tier 0 is the default for `bash scripts/bootstrap.sh` with no flag. Tier 1 stays available via `--tier 1`. The OSS-release framing is "runs with just Node" rather than "runs with Docker + Supabase."

## The abstraction boundary

Two abstractions, not one — because the web app cannot speak raw Postgres.

**Server-side: Postgres connection.** MCP server and the Node HTTP backend share a single `pg.Pool` driven by `DATABASE_URL`, with a `withUserContext(userId, fn)` helper that sets `app.current_user_id` (Tier 0 stub) and `request.jwt.claim.sub` (Tier 1 real) GUCs so `auth.uid()` resolves correctly across tiers.

**Client-side: HTTP API contract.** The web app's `src/services/*.ts` calls go through a `dbClient` factory at `src/lib/dbClient.ts`. Tier 1 wraps `@supabase/supabase-js`; Tier 0/2 use `fetch` against the local backend's REST surface (`/api`, `/storage/v1`, `/functions/v1`). Components are unchanged.

## What's in this repo

Tier 0 ships as the default in v0.2.0; Tier 1 stays fully supported. Tier 2 is a future config change (point `DATABASE_URL` at a hosted Postgres); Tier 3+ is not part of the OSS plan.

Storage tiers are orthogonal to publishing / social features. The earlier doc's "publish opt-in / social layer" idea folds in as a future feature flag rather than its own tier.

## Switching tiers

`media_url` values are portable across tiers — the same Supabase-shaped URL works on Tier 0 and Tier 1. The **photo binaries** are not: Tier 0 stores them flat under `~/.plannen/photos/event-photos/<event>/<user>/<file>`, while Tier 1 keeps them in the Supabase Storage Docker volume as `<tenant>/<project>/<bucket>/<path>/<file>/<version-uuid>`. Switching tiers means moving both the SQL rows and the binaries, and rewriting the photo layout.

### Tier 1 → Tier 0 (supported)

One command, assuming the Tier 1 stack is up and `~/.plannen/pgdata` doesn't exist yet:

```bash
bash scripts/migrate-tier.sh 1 0
```

It records row counts on Tier 1, runs `export-seed.sh`, stops the Tier 1 stack (Tier 0 reuses port 54322), flips `PLANNEN_TIER` in `.env`, runs `bootstrap.sh --tier 0 --non-interactive`, then re-counts on Tier 0 and reports a per-table diff. Pass `--yes` to wipe an existing `~/.plannen/pgdata` first (destructive).

Manual equivalent if you'd rather drive it yourself:

```bash
# On Tier 1
bash scripts/export-seed.sh          # → supabase/seed.sql + seed-photos.tar.gz
supabase stop --project-id plannen
bash scripts/functions-stop.sh

# Then on the same machine, with ~/.plannen/pgdata absent
# (PLANNEN_TIER set to 0 in .env)
bash scripts/bootstrap.sh --tier 0
# Bootstrap auto-restores the seed + photos on first init.
```

`restore-seed.mjs` extends Tier 0's stub `auth.users` with the columns the Tier 1 dump expects (nullable) and rewrites `media_url` / `image_url` / `cover_url` to drop the hard-coded `127.0.0.1:54321` host. `restore-photos.mjs` flattens Supabase's `<file>/<version-uuid>` directories down to plain files.

### Tier 0 → Tier 1 (not yet)

Tracked in [issue #8](https://github.com/pariksheet/plannen/issues/8). The Tier 0 export produces a tarball with the flat 4-component layout and a `pg_dump` that only covers the stub `auth.users` columns, but the Tier 1 restore path needs:

1. **Photo layout conversion** — `restore-photos.sh`'s Tier 1 branch does `find /mnt -mindepth 5 -type f`, so the flat Tier 0 layout silently restores zero files.
2. **auth.users backfill** — GoTrue refuses to issue a magic link unless `aud`, `role`, `instance_id`, and `email_confirmed_at` are populated; the Tier 0 dump doesn't carry them.

Until both are in place, `scripts/migrate-tier.sh 0 1` aborts with a pointer to this issue.

### Tier 2 (future)

When a Tier 2 path lands (external Postgres + remote storage), the same `migrate-tier.sh` should grow `1 → 2` and `0 → 2` arms. The work in Phase 2 of issue #8 — layout converter and auth backfill — is the prerequisite.
