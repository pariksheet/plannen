# Tier 0 → Tier 1 Migration & Auto-Snapshot — Design

**Date:** 2026-05-16
**Status:** Design approved; implementation in `feat/tier0-to-tier1-migration`
**Related:** `2026-05-09-bootstrap-and-setup-story-design.md`, `docs/TIERED_DEPLOYMENT_MODEL.md`

## Context

Two gaps surfaced when a user on Tier 0 ran `bash scripts/bootstrap.sh --tier 1` expecting their data to follow:

1. **Tier 1 bootstrap does not import the seed.** `bootstrap.sh`'s Tier 1 branch (lines 217–243) runs `supabase migration up` and an `auth.users` resolve step — and stops. The Tier-0-only branch auto-restores `supabase/seed.sql` (lines 181–202), but Tier 1 does nothing equivalent. The Tier 1 Docker volume keeps whatever state it had previously, so the user lands on stale data.
2. **`supabase/seed.sql` is Tier-0-shaped.** Even if Tier 1 did import it, three things would still be broken: `media_url` columns are relative (`/storage/v1/object/public/…`), the photo tarball uses Tier 0's flat layout (no Supabase version-uuid leaf directory), and `storage.objects` rows are absent.

A related risk: re-running `bootstrap.sh` itself can be destructive if the user forgot to run `export-seed.sh` first. The Tier 0 branch's seed-restore is gated by `USER_COUNT=0` so it's protected against most cases, but the "user manually wiped pgdata and re-ran bootstrap" path will quietly restore from a stale `supabase/seed.sql` and lose any post-seed work.

This spec fixes both. Tier 0 → Tier 1 only — reverse migration and Tier 1 → Tier 2 are out of scope.

## Goals & non-goals

### Goals

- `bash scripts/bootstrap.sh --tier 1` on a populated Tier 0 install carries every user-owned artefact across to Tier 1: events, memories, sources, family, profile facts, stories, photos. The web UI on Tier 1 renders identically to how Tier 0 rendered before.
- No data loss is possible from re-running `bootstrap.sh`, regardless of whether the user backed up first. Every destructive step is preceded by an automatic snapshot.
- Single user-facing command. `bash scripts/bootstrap.sh --tier 1` is the only entrypoint.

### Non-goals

- Tier 1 → Tier 0 reverse migration.
- Tier 1 → Tier 2 forward migration. (Separate spec when Tier 2 ships.)
- Changing `scripts/export-seed.sh`'s public surface. It stays the named-backup command. Auto-snapshots live elsewhere.
- Multi-user.
- A snapshot-restore CLI. Auto-snapshots are an undo-net; restoring from one is a documented manual procedure.

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Migration trigger | `bootstrap.sh --tier 1` detects `PLANNEN_TIER=0` in the existing `.env` AND a non-empty `~/.plannen/pgdata`. If both, it's a tier change. | Explicit `--migrate-from-tier 0` flag; new `scripts/migrate-to-tier1.sh` user-command. Rejected because both contradict "seamless one command". |
| Implementation shape | Three new Node helpers under `scripts/lib/`. Bootstrap orchestrates via thin bash. | Inline everything in `bootstrap.sh` (bash struggles with photo synthesis); a single big helper (storage-objects synthesis is worth isolating for testability). |
| Snapshot location | `.plannen/snapshots/<ISO>.{sql.gz,photos.tar.gz}` inside the repo; gitignored; auto-prune to last 5. | `~/.plannen/snapshots/` (harder to discover, but survives `git clean -fdx`); overwriting `supabase/seed.sql` (collides with user-blessed seeds); no pruning (disk bloat). |
| Photo carry-over completeness | Lossless. Synthesize `storage.objects` rows, lay out files in Supabase's version-uuid format, rewrite `media_url` to absolute `http://127.0.0.1:54321/...`. | Best-effort with warning; skip photos in this spec. Rejected because the user expects the web UI to "just work" after migration. |
| Auto-snapshot scope | Snapshot both source tier (Tier 0, before migration) AND target tier (Tier 1, before any destructive step on it). | Source-only. Rejected because re-running `--tier 1` after data already landed could overwrite real Tier 1 work. |
| `export-seed.sh` role | Unchanged. Still the user-facing named-backup command, still writes `supabase/seed.sql` + `supabase/seed-photos.tar.gz`. | Redirect its output to `.plannen/snapshots/`; deprecate it entirely. Both rejected — the existing surface is documented in CLAUDE.md and the plannen-core skill, and consolidating is a separate cleanup. |

## Components

```
scripts/
  bootstrap.sh                              ← +~30 lines (detect + orchestrate)
  lib/
    snapshot.mjs                            (new) tier-aware snapshot utility
    storage-objects.mjs                     (new) pure Supabase storage row synthesis
    migrate-tier0-to-tier1.mjs              (new) orchestrator
.plannen/
  snapshots/                                (new dir, gitignored)
    2026-05-16T10-01-00Z.sql.gz
    2026-05-16T10-01-00Z-photos.tar.gz
    …last 5 retained
```

### `scripts/lib/snapshot.mjs`

Single responsibility: snapshot a given tier's current state to a timestamped pair of files; prune older snapshots.

CLI: `node scripts/lib/snapshot.mjs --tier {0|1} --out <dir> [--keep N]`

Behaviour:

- `--tier 0`: dumps from embedded Postgres via `DATABASE_URL=postgres://plannen:plannen@127.0.0.1:54322/plannen` using the existing `dump-tables.mjs` logic (imports it). Tars `~/.plannen/photos/` (or `$PLANNEN_PHOTOS_ROOT`).
- `--tier 1`: dumps from Docker Postgres via the existing `pg_dump` pathway in `export-seed.sh` (`docker exec supabase_db_plannen pg_dump …`). Tars `supabase_storage_plannen:/mnt`.
- Output: `<out>/<ISO timestamp>.sql.gz` and `<out>/<ISO timestamp>-photos.tar.gz`. ISO timestamp uses `:` replaced with `-` so the path is safe on all filesystems.
- After write: list snapshots in `<out>`, keep the most recent `N` (default 5), delete the rest (both `.sql.gz` and matching `-photos.tar.gz`).
- If the source tier has no data (counts are zero or pgdata is missing), exits 0 with a logged note; doesn't error.

### `scripts/lib/storage-objects.mjs`

Pure synthesis — no I/O. Given a list of photos `[{ bucket, path, size, mimetype, owner }]`, returns the rows to insert into `storage.objects` and the file-layout map for the container.

Supabase storage's `name` column for an object at `event-photos/<event>/<user>/<filename>` is the full path `<event>/<user>/<filename>` (the bucket goes in `bucket_id`). Files on disk live at `/mnt/stub/stub/event-photos/<event>/<user>/<filename>/<version-uuid>`. The version-uuid is the `version` column in `storage.objects` (a UUID we generate at synthesis time).

Required `storage.objects` columns (verified against Tier 1 Supabase 17):

- `id` — generated UUID per row
- `bucket_id` — `'event-photos'`
- `name` — relative path inside bucket
- `owner` — owning user UUID
- `owner_id` — same UUID as text
- `created_at`, `updated_at`, `last_accessed_at` — `now()`
- `metadata` — JSON with `size`, `mimetype`, `cacheControl: 'max-age=3600'`, `lastModified` (ISO), `contentLength` (same as size), `httpStatusCode: 200`, `eTag` (synthesized)
- `version` — UUID (matches the leaf-dir name on disk)
- `user_metadata` — empty JSON `{}`

This module exports `synthesize(files)` returning `{ rows, layout }` where `rows` is an array of objects ready for parameterized INSERT and `layout` is `[{ srcAbsPath, destRelPath }]` describing where each file should land inside the container's `/mnt/stub/stub/`.

### `scripts/lib/migrate-tier0-to-tier1.mjs`

Orchestrator. Preconditions: Tier 0 Postgres reachable at `DATABASE_URL_TIER0`; Tier 1 Supabase stack up; Tier 1 migrations applied; Tier 1 `auth.users` row for `PLANNEN_USER_EMAIL` already exists (bootstrap step 6 takes care of this before invoking the migrator).

Steps:

1. **Dump Tier 0.** Use the same logic as `dump-tables.mjs` to produce an in-memory SQL string. (We don't write to disk — the snapshot already did that.)
2. **Inventory Tier 0 photos.** Walk `~/.plannen/photos/event-photos/` to list every file. For each: capture `bucket = 'event-photos'`, `path = <event>/<user>/<filename>`, `size`, `mimetype` (from extension), `owner` (parsed from path: `<event>/<owner>/<filename>` — owner is the second component).
3. **TRUNCATE Tier 1 plannen.* + auth.users** (same list as `restore-seed.mjs`).
4. **Apply Tier 0 dump to Tier 1** with `session_replication_role=replica`. The dump's `auth.users` INSERT will populate the same UUIDs the user has on Tier 0, preserving FK consistency. (Bootstrap step 6's pre-created auth row gets removed by the TRUNCATE then re-inserted by the dump.)
5. **Rewrite media URLs to absolute.** `UPDATE plannen.event_memories SET media_url = 'http://127.0.0.1:54321' || media_url WHERE media_url LIKE '/storage/v1/%'` — same for `events.image_url` and `stories.cover_url`. This is the inverse of `restore-seed.mjs`'s step 4.
6. **Synthesize storage.objects.** Call `storage-objects.synthesize(inventory)`. Bulk-INSERT the rows.
7. **Copy photos into the storage container.** For each `{srcAbsPath, destRelPath}` in the layout: `docker cp <srcAbsPath> supabase_storage_plannen:<destRelPath>`. Use a single `tar c | docker exec ... tar x` pipe instead of many `docker cp` invocations for speed.
8. **Verify.** Counts of `plannen.events`, `plannen.event_memories`, `plannen.event_sources`, `plannen.family_members`, `plannen.profile_facts`, `plannen.stories`, `storage.objects WHERE bucket_id='event-photos'` between Tier 0 source and Tier 1 destination must match. Log any mismatch with row deltas.

Idempotency: re-running clears Tier 1 first (step 3), so repeated calls converge on the same end state.

### `bootstrap.sh` changes

Before the Tier 1 branch's "step 4. Starting local Supabase":

```bash
# Pre-flight: tier change detection
OLD_TIER=$(grep -E '^PLANNEN_TIER=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || echo "")
TIER_CHANGE=""
if [ "$OLD_TIER" = "0" ] && [ "$TIER" = "1" ] && [ -d "$HOME/.plannen/pgdata" ]; then
  TIER_CHANGE="0->1"
  step "0a. Snapshotting Tier 0 before migration (auto-backup)"
  mkdir -p "$PROJECT_DIR/.plannen/snapshots"
  # Start Tier 0 pg if not running, so we can dump it.
  if ! nc -z 127.0.0.1 54322 2>/dev/null; then
    bash "$PROJECT_DIR/scripts/pg-start.sh"
  fi
  node "$PROJECT_DIR/scripts/lib/snapshot.mjs" --tier 0 \
    --out "$PROJECT_DIR/.plannen/snapshots" --keep 5
  bash "$PROJECT_DIR/scripts/pg-stop.sh"
  ok "Tier 0 snapshot saved"
fi
```

After Tier 1's step 6 (auth user resolve), and before the existing "step 7. Write .env":

```bash
if [ "$TIER_CHANGE" = "0->1" ]; then
  step "6b. Snapshotting empty Tier 1 (auto-backup)"
  node "$PROJECT_DIR/scripts/lib/snapshot.mjs" --tier 1 \
    --out "$PROJECT_DIR/.plannen/snapshots" --keep 5

  step "6c. Migrating Tier 0 data → Tier 1"
  DATABASE_URL_TIER0="postgres://plannen:plannen@127.0.0.1:54322/plannen" \
  DATABASE_URL_TIER1="$(env_get "$EXAMPLE_FILE" DATABASE_URL)" \
    node "$PROJECT_DIR/scripts/lib/migrate-tier0-to-tier1.mjs"
  ok "Tier 0 data migrated to Tier 1"
fi
```

Note: the Tier 0 PG needs to be running for the migrator's dump phase. Bootstrap re-starts it for the snapshot, stops it (because Tier 1's Docker pg binds the same port), then starts Tier 1's stack. The migrator briefly starts Tier 0 PG again on a side port via `pg-start.sh` with a `PLANNEN_PG_PORT=54422` override — added as part of this work.

## Data flow

```
user runs: bash scripts/bootstrap.sh --tier 1
  ├─ detect OLD_TIER=0 + pgdata exists → TIER_CHANGE=0->1
  ├─ start Tier 0 PG on 54322
  ├─ snapshot.mjs --tier 0 → .plannen/snapshots/<ts>.{sql.gz, photos.tar.gz}
  ├─ stop Tier 0 PG
  ├─ supabase start (Tier 1 stack; Docker pg on 54322)
  ├─ supabase migration up
  ├─ resolve auth.users row for PLANNEN_USER_EMAIL
  ├─ snapshot.mjs --tier 1 → snapshot the empty Tier 1
  ├─ start Tier 0 PG on side port 54422
  ├─ migrate-tier0-to-tier1.mjs
  │    ├─ read Tier 0 → SQL dump (in-memory)
  │    ├─ inventory Tier 0 photos
  │    ├─ TRUNCATE Tier 1 plannen.* + auth.users
  │    ├─ apply dump to Tier 1
  │    ├─ rewrite media_url paths to absolute
  │    ├─ synthesize storage.objects rows
  │    ├─ tar-pipe photos into supabase_storage_plannen:/mnt/stub/stub/
  │    └─ verify counts match
  ├─ stop Tier 0 PG
  ├─ write .env (PLANNEN_TIER=1, …)
  └─ functions serve / plugin install (unchanged)
```

## Failure modes & idempotency

| Step | Failure | Behaviour |
|---|---|---|
| Snapshot Tier 0 | Tier 0 PG fails to start (corrupt pgdata?) | Bootstrap aborts with the pg log path. User triages; bootstrap can be re-run after fixing. |
| Snapshot Tier 1 | New `supabase start` failed earlier | Already caught upstream; this step is unreachable. |
| Migrator: dump | Tier 0 PG dies mid-dump | Migrator aborts; bootstrap aborts. The snapshot from step 0a is on disk, so user can recover. Re-running bootstrap is safe. |
| Migrator: TRUNCATE on Tier 1 | Lock conflict | Wait + retry once; if still failing, abort. The Tier 1 snapshot from step 6b is on disk. |
| Migrator: apply dump | Duplicate-key error (auth.users row from step 6 not fully cleared) | Catch + log + abort. Investigation: did TRUNCATE actually fire? Bug, not user error. |
| Migrator: docker exec tar | Container not running | Abort with `supabase status` hint. |
| Migrator: verify | Counts mismatch | Log per-table delta; exit non-zero. The Tier 1 snapshot from step 6b is the recovery path. |

**Re-running `bootstrap.sh --tier 1` after a successful migration:** `OLD_TIER` is now `1` (rewritten in step 7), so `TIER_CHANGE` does not fire again. Bootstrap behaves as today's Tier 1 idempotent path.

**Re-running after a failed migration:** `OLD_TIER` is still `0` (step 7 only writes `.env` on success). `TIER_CHANGE` fires again; the migrator's TRUNCATE+apply makes it idempotent. The snapshot from step 0a is preserved (snapshots are pruned by count, not by tier change).

## Files added / modified

### Added

- `scripts/lib/snapshot.mjs` — ~80 lines.
- `scripts/lib/storage-objects.mjs` — ~60 lines, pure.
- `scripts/lib/migrate-tier0-to-tier1.mjs` — ~150 lines.
- `tests/snapshot.test.mjs`, `tests/storage-objects.test.mjs`, `tests/migrate-tier0-to-tier1.test.mjs` — unit + integration tests.
- `.plannen/snapshots/` (gitignored — `.plannen/` is already ignored per the bootstrap-and-setup-story spec).

### Modified

- `scripts/bootstrap.sh` — +~30 lines of detect + orchestrate around the Tier 1 branch.
- `scripts/lib/plannen-pg.mjs` — accept `PLANNEN_PG_PORT` env override so the migrator can run Tier 0 PG on 54422 alongside Tier 1's Docker PG on 54322.

### Unchanged

- `scripts/export-seed.sh`
- `scripts/lib/restore-seed.mjs`, `scripts/lib/restore-photos.mjs` (Tier 0 paths)
- `scripts/lib/dump-tables.mjs` (imported by the new modules)

## Testing

### Unit tests

- `snapshot.test.mjs`: filename ISO formatting (colons replaced), retention math (keeps last 5 by mtime, deletes both `.sql.gz` and matching `-photos.tar.gz`), no-op when source has no data.
- `storage-objects.test.mjs`: given a fixture photo list, synthesizes the expected rows (column shape, name/path normalization, version-uuid stability with a seeded RNG).

### Integration test

- `tests/migrate-tier0-to-tier1.integration.test.mjs`: assumes Docker + supabase CLI present.
  1. Snapshot current state.
  2. Bring up Tier 0 with the existing `supabase/seed.sql` as source.
  3. Bring up Tier 1.
  4. Invoke `migrate-tier0-to-tier1.mjs`.
  5. Assert: events count, memories count, sources count, family count, profile_facts count, stories count match between Tier 0 source and Tier 1 destination.
  6. Assert: `storage.objects` count = file count in tarball.
  7. Assert: `media_url` paths in Tier 1 are absolute (start with `http://127.0.0.1:54321/`).
  8. Restore original state.

Skipped in CI today (CI doesn't have Docker yet); runnable locally with `npm run test:integration`.

## Risks & open questions

- **Supabase storage schema drift.** `storage-objects.mjs` hard-codes the column set verified against Supabase 17 (the version currently in `local-start.sh`). If supabase upgrades the storage schema, this synthesis breaks. Mitigation: the integration test catches schema drift on the next run; document in the file header which Supabase version it targets.
- **Owner UUID parsing.** The migrator parses owner UUID from the photo path's second component (`event-photos/<event>/<user>/<filename>`). If a photo path ever uses a different layout, owner will be wrong. Verified that today's `event-photos` bucket always uses this layout; assert in the migrator and fail-fast if a path violates it.
- **Concurrent edits during migration.** The web app may have a tab open against Tier 0 while migration runs. The TRUNCATE-then-apply pattern means Tier 1 sees a consistent snapshot moment; Tier 0 isn't modified by the migrator (read-only). The user has to close any open Tier 0 web sessions before migrating — added to the bootstrap final printout.
- **Side-port (`54422`) availability.** If another process is bound to 54422, the migrator's Tier 0 PG bring-up fails. Probe + fail-fast with a clear message; user can override via `PLANNEN_PG_MIGRATION_PORT`.

## Cross-references

- `docs/superpowers/specs/2026-05-09-bootstrap-and-setup-story-design.md` — the bootstrap script this spec extends.
- `docs/TIERED_DEPLOYMENT_MODEL.md` — tier definitions.
- `scripts/lib/restore-seed.mjs`, `scripts/lib/restore-photos.mjs` — Tier 0 restore paths the new migrator is modeled after.
- `scripts/lib/dump-tables.mjs` — reused by `snapshot.mjs` and `migrate-tier0-to-tier1.mjs`.
