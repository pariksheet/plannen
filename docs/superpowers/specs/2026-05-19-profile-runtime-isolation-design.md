# Profile Runtime Isolation

**Date:** 2026-05-19
**Type:** Bug fix — finish what PR2 started.
**Status:** Approved — implementation plan pending.
**Issue:** [#21 — Profiles: simultaneous-run port isolation not enforced by wrapped scripts](https://github.com/pariksheet/plannen/issues/21)

## Problem

PR2 (#20) shipped named profiles and a port-offset allocator, but the wrapped scripts and the Vite dev server still hardcode global ports and global paths:

| Surface | What's hardcoded today |
|---|---|
| `vite.config.ts` | `port: 4321` (server + preview), `strictPort: true` |
| `supabase/config.toml` | `54321` API, `54322` DB, `54323` studio, `54324` inbucket, `project_id = "plannen"` |
| `scripts/lib/plannen-pg.mjs` PID file | `~/.plannen/pg.pid` (global) |
| `scripts/lib/plannen-pg.mjs` DATA_DIR | `~/.plannen/pgdata` (overridable via env, but profile create doesn't set it) |
| `backend/src/routes/storage/eventPhotos.ts` photos root | `~/.plannen/photos` (overridable via env, but profile create doesn't set it) |

Sequential profile switching works (`plannen down` → `profile use <other>` → `up`). **Simultaneous use is broken.** Two `local_pg` profiles fight over `~/.plannen/pgdata`, `~/.plannen/photos`, port 54322/54323/4321, and the global PG pid file. Two `local_sb` profiles additionally fight over the Supabase API/DB/studio ports and the Docker container names (which derive from `project_id`).

## Decision

Make every per-profile resource — ports, paths, pid file, Supabase workdir, and Docker container names — actually per-profile. Two profiles in any combination of modes can run concurrently after this PR.

Approach is **best-effort isolation**: when something genuinely cannot be made simultaneous-safe, refuse loudly at `up` time with a clear error rather than silently corrupting state.

The Supabase config piece uses **per-profile workdir** (`SUPABASE_WORKDIR`), not `env()` interpolation — the Supabase CLI's `env()` substitution does not support integer fields like `port` ([supabase/cli#1551](https://github.com/supabase/cli/issues/1551)).

## End-state

### Profile env file — broadened keyset

`cli/lib/profiles.mjs::portsFor(mode, offset)` is renamed to `runtimeEnvFor(mode, offset, profileDir)` and emits both ports and per-profile paths:

```
# local_pg
PLANNEN_PG_PORT      = 54322 + offset
PLANNEN_BACKEND_PORT = 54323 + offset
PLANNEN_WEB_PORT     = 4321  + offset
PLANNEN_PG_DATA      = <profileDir>/pgdata
PLANNEN_PG_PID       = <profileDir>/pg.pid
PLANNEN_PHOTOS_ROOT  = <profileDir>/photos

# local_sb
PLANNEN_SUPABASE_API_PORT    = 54321 + offset
PLANNEN_PG_PORT              = 54322 + offset
PLANNEN_SUPABASE_STUDIO_PORT = 54324 + offset
PLANNEN_SUPABASE_INBUCKET_PORT = 54325 + offset
PLANNEN_WEB_PORT             = 4321  + offset
SUPABASE_WORKDIR             = <profileDir>
# (Photos for local_sb live inside the Supabase storage container's volume,
# not under our control — no PLANNEN_PHOTOS_ROOT needed at steady state.)

# cloud_sb (unchanged)
PLANNEN_WEB_PORT = 4321 + offset
```

`profile create` writes these into the profile's env file at creation time. Existing profiles get backfilled on first `plannen up` (see "Migration" below).

### Per-profile Supabase workdir

For `local_sb` profiles, `~/.plannen/profiles/<name>/` becomes a valid Supabase workdir by populating:

```
~/.plannen/profiles/<name>/
├── env                          # profile env file (unchanged surface)
├── profile.json                 # manifest (unchanged surface)
├── pgdata/                      # local_pg only
├── photos/                      # local_pg only (local_sb photos live in Supabase storage container)
├── pg.pid                       # local_pg only
└── supabase/                    # NEW — Supabase workdir
    ├── config.toml              # generated (port_offset + project_id substituted)
    ├── migrations/              → symlink to <repo>/supabase/migrations
    ├── migrations-tier0/        → symlink to <repo>/supabase/migrations-tier0
    ├── functions/               → symlink to <repo>/supabase/functions
    ├── seed.sql                 → symlink to <repo>/supabase/seed.sql
    └── templates/               → symlink to <repo>/supabase/templates
```

**Template.** The current `supabase/config.toml` becomes `supabase/config.toml.tmpl` with five placeholder substitutions:

```toml
project_id = "{{PROJECT_ID}}"

[api]
port = {{API_PORT}}
…

[db]
port = {{DB_PORT}}
…

[studio]
port = {{STUDIO_PORT}}
…

[inbucket]
port = {{INBUCKET_PORT}}
smtp_port = {{INBUCKET_SMTP_PORT}}
pop3_port = {{INBUCKET_POP3_PORT}}
```

Inbucket has three ports (54324 HTTP, 54325 SMTP, 54326 POP3). Each gets an explicit placeholder computed from `port_offset` — the renderer doesn't do arithmetic inside the template. The repo retains a `supabase/config.toml` checked in, but it becomes generated output for the `default` profile (rendered at first install). Git keeps tracking it; bootstrap regenerates if missing.

**Project ID.** `{{PROJECT_ID}}` resolves to `plannen_<name>` (e.g. `plannen_default`, `plannen_staging`). This is the docker container prefix Supabase CLI uses for service containers (`supabase_db_<id>`, `supabase_kong_<id>`, etc.). Making it per-profile avoids container-name collisions when two `local_sb` stacks are up.

**Renderer.** New module `cli/lib/supabase-workdir.mjs` exports:

```js
export function ensureSupabaseWorkdir({ name, env, repoRoot }) → { workdir, rendered: boolean }
```

Behavior:
1. Compute `workdir = <profileDir>/supabase`.
2. Read manifest for `port_offset`.
3. Substitute the template at `<repoRoot>/supabase/config.toml.tmpl` and write to `<workdir>/config.toml` (only if content would change — idempotent).
4. For each of `migrations`, `migrations-tier0`, `functions`, `seed.sql`, `templates`: ensure a symlink at `<workdir>/<name>` pointing to `<repoRoot>/supabase/<name>`. Replace if it points elsewhere; no-op if correct.
5. Return whether anything was rendered/relinked (so callers can log it).

Called from: `profile create` (for local_sb profiles), `profile use`, and the front of `plannen up`. Idempotent — safe to call every `up`.

**Audit of `supabase` invocations.** Every call site must pass through `composeEnv(name)` so `SUPABASE_WORKDIR` reaches the child process:

| Call site | How env reaches it today | Action |
|---|---|---|
| `scripts/functions-start.sh` | sourced via `.env` symlink | Already OK — `SUPABASE_WORKDIR` is in the env file |
| `scripts/bootstrap.sh` (`supabase start`) | sourced via `.env` symlink | Already OK |
| `cli/commands/cloud/provision.mjs` | `composeEnv()` | Already OK |
| `scripts/lib/migrate-tier1-to-tier2.mjs` (`supabase link/db push/functions deploy`) | `process.env` from caller | Already OK — caller passes composed env |

No new plumbing required; the env file is the carrier.

### vite.config.ts

```ts
const env = loadEnv(mode, process.cwd(), '')
const port = Number(env.PLANNEN_WEB_PORT ?? 4321)
// …
server: { port, strictPort: true, … },
preview: { port, strictPort: true },
```

`strictPort: true` stays. The per-profile port is unique by allocation, so a clash now indicates a real misconfiguration worth failing on (it would be ambiguous to silently shift to a different port that some *other* profile expects).

### PG pid file

`scripts/lib/plannen-pg.mjs`:

```js
const PID_FILE = process.env.PLANNEN_PG_PID ?? join(homedir(), '.plannen', 'pg.pid')
```

Default = today's global path, so legacy direct invocations (`node scripts/lib/plannen-pg.mjs start` without profile context) still work.

### `profile use` — widen the running-services probe

`cli/commands/profile/use.mjs` today only probes the previous profile's PG port. Extend to probe the full per-mode port set:

| Previous profile mode | Ports probed |
|---|---|
| `local_pg` | PG, backend, web |
| `local_sb` | Supabase API, PG, studio, web |
| `cloud_sb` | web |

Computed from `prevManifest.mode` + `prevManifest.port_offset` using the same `runtimeEnvFor()` helper. Refuse with a message that lists *which* ports are still open, so users know what to stop.

### Migration of existing `default` profile

PR2 introduced profile dirs but left existing local data at `~/.plannen/pgdata` / `~/.plannen/photos` / `~/.plannen/pg.pid`. Until those move into the profile dir, the new env vars point at empty directories — the user would lose their data on first `plannen up` after this PR.

`plannen up` runs a one-shot migration before starting services:

1. Resolve the active profile and its expected paths from `runtimeEnvFor()`.
2. For each legacy path that still exists at the global location AND whose target inside the profile dir does not exist:
   - `~/.plannen/pgdata` → `<profileDir>/pgdata` (`fs.renameSync` — atomic on same filesystem)
   - `~/.plannen/photos` → `<profileDir>/photos`
   - `~/.plannen/pg.pid` → `<profileDir>/pg.pid` (only if pid is alive; otherwise unlink)
3. For local_sb profiles: call `ensureSupabaseWorkdir`.
4. If any env-file key is missing (`PLANNEN_PG_DATA`, `PLANNEN_PHOTOS_ROOT`, `SUPABASE_WORKDIR`, etc.), rewrite the profile env file to include them. Preserve all other keys.
5. Log each action: `migrated pgdata → ~/.plannen/profiles/default/pgdata`.

Idempotent — second run is a no-op. If both source (`~/.plannen/pgdata`) and target (`<profileDir>/pgdata`) exist, refuse the migration for that path with a clear error: we can't tell which is canonical, and silently picking either could destroy work. User resolves manually (delete the stale one). Migration runs in a new helper `cli/lib/profile-migrate-legacy.mjs` so it's unit-testable independently of `up`.

### Refusal modes

`plannen up` does one extra check post-migration: it probes the about-to-bind ports of the active profile. If any are already in use (by some other process, or by another profile that's `up`), it refuses with a clear list. This catches the case where the user accidentally creates two profiles with the same port_offset (shouldn't happen via `nextPortOffset`, but possible via manual `profile.json` edit).

## Tests

| Layer | New tests |
|---|---|
| `cli/lib/profiles.mjs` | `runtimeEnvFor` emits expected keys per mode; offset arithmetic |
| `cli/lib/supabase-workdir.mjs` | renders config.toml with substitutions; creates 5 symlinks; idempotent on second run; re-renders on offset change; replaces a wrong symlink target |
| `cli/lib/profile-migrate-legacy.mjs` | moves pgdata/photos/pid into profile dir; no-ops when source missing; no-ops when target already populated; rewrites env file with missing keys |
| `cli/commands/profile/use.mjs` | probe lists all per-mode ports; error message names which port is still bound |
| `cli/commands/up.mjs` | calls legacy migration then `ensureSupabaseWorkdir` for local_sb; refuses on port collision |
| Integration (gated `PLANNEN_INTEGRATION=1`) | two `local_pg` profiles `up` simultaneously in a tmp HOME; assert each binds its expected port set; both `down` cleanly |

The integration test is skipped in regular CI (boots two real embedded-Postgres instances; ~5s). It runs on demand and on the `tier-0-bootstrap.yml` regression workflow.

## Out of scope

- `plannen profile rename` (would need to move pgdata + photos and rewrite the env file's path keys — separate concern).
- Graceful shutdown improvements in `plannen-pg.mjs`.
- Docker container cleanup when `supabase stop` fails (rare; user-driven recovery via `docker ps | grep supabase_`).
- Publishing the broadened key set to `.env.example` — that's a docs follow-up.
- Per-profile branch state for `git worktree`-based parallel checkouts (orthogonal — the worktree is its own repo root, so its `.env` symlink resolves to a different profile anyway).

## References

- [PR2 — Profile system (#20)](https://github.com/pariksheet/plannen/pull/20)
- [PR3a — Synthetic profile mode (#22)](https://github.com/pariksheet/plannen/pull/22)
- [Issue #21 — this design's driver](https://github.com/pariksheet/plannen/issues/21)
- [supabase/cli#1551 — env() doesn't support integers](https://github.com/supabase/cli/issues/1551)
- [Supabase CLI config docs — SUPABASE_WORKDIR / --workdir](https://supabase.com/docs/guides/cli/config)
- [`docs/superpowers/specs/2026-05-17-plannen-cli-and-cicd-design.md`](./2026-05-17-plannen-cli-and-cicd-design.md) — the parent CLI/CI spec; profile system definition.
