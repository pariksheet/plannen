# Plannen CLI + CI/CD

**Date:** 2026-05-17
**Type:** Developer ergonomics + release-flow design
**Status:** Approved — implementation plan pending.

## Problem

Today Plannen ships as a constellation of bash scripts under `scripts/` plus one big `bootstrap.sh` that takes a `--tier 0|1|2` flag. That works, but three pains compound:

1. **Script-zoo ergonomics.** A daily session is `pg-start.sh` → `backend-start.sh` → `npm run dev`, plus `functions-start.sh` on Tier 1, plus the maintenance scripts (`export-seed.sh`, `migrate-tier.sh`, `restore-photos.sh`, `mcp-mode.sh`, `mcp-rotate-bearer.sh`, `skills-install.sh`, `vercel-deploy.sh`, `cloud-doctor.mjs`, `smoke-cli-provider.sh`). Each is its own argv shape and contract. There's no shared discovery surface.
2. **Mode-collision when testing.** All three tiers want port 54322 for Postgres, `~/.plannen/pgdata`, `~/.plannen/photos`, the repo `.env`, and the global `supabase/.temp` link state. Switching tiers is destructive — you can't compare Tier 0 against Tier 1 side-by-side without stomping state.
3. **No cloud staging→prod flow.** Tier 2 has one Supabase + one Vercel project today (the user's real personal data). Merging to `main` doesn't deploy anywhere automatically; there's no separate staging environment to test cloud changes against before they hit the real DB.

## Decision

Build one Node CLI — `plannen` — that owns every operational verb in the repo. Local state isolates into **named profiles**. CI/CD targets a **two-Supabase + two-Vercel** topology with auto-deploy to staging on merge and a `workflow_dispatch`-gated promote to prod.

The implementation is **phased: wrap, then absorb**. PR1 ships the CLI surface delegating to the existing bash scripts; PR2 adds profiles; PR3 ships cloud provisioning + CI/CD; PR4+ replaces each bash script with its in-CLI implementation.

This is "approach C — spine-then-skin" from the brainstorming round.

## End-state architecture

### Entry point

A Node binary at `bin/plannen.mjs`, registered in `package.json` as `"bin": { "plannen": "./bin/plannen.mjs" }`. After `npm install`, `npx plannen <cmd>` works inside the cloned repo. An npm-script alias (`"plannen": "node ./bin/plannen.mjs"`) lets `npm run plannen -- <cmd>` work for users who avoid `npx`. Not published to the npm registry in v1.

**Runtime.** Node 20+ ESM, vanilla `.mjs` (matches the rest of `scripts/lib/`). Command parsing via [`citty`](https://github.com/unjs/citty) — small, modern, supports nested subcommands cleanly. No TypeScript inside the CLI itself.

### CLI command surface

```
plannen
├── init                              # one-shot bootstrap (replaces bootstrap.sh)
├── up                                # start active profile's processes
├── down                              # stop active profile's processes
├── status                            # what's running for the active profile
├── doctor                            # diagnostics (folds cloud-doctor.mjs)
├── deploy   --mode=<m>               # bring a profile online for its mode
├── promote                           # staging → prod (cloud_sb only)
├── profile
│   ├── create <name> --mode=<m>
│   ├── use    <name>
│   ├── list
│   └── delete <name>
├── db
│   ├── migrate                       # forward-only schema migrations
│   ├── export                        # dump SQL + photos tarball
│   ├── restore                       # inverse of export
│   └── migrate-tier <from> <to>      # cross-tier migrations (1→0 today)
├── mcp
│   ├── mode local|cloud
│   └── rotate-bearer
├── cloud
│   └── provision --target staging|prod
└── install
    ├── plugin
    ├── skills
    └── all
```

**Mode names.** `local_pg`, `local_sb`, `cloud_sb` are the canonical mode strings (mapping to Tier 0, 1, 2 internally). The CLI accepts `tier0|tier1|tier2` as aliases. The rest of the codebase keeps reading `PLANNEN_TIER=0|1|2` from env — no churn beyond the CLI layer.

**Global flags** valid on every command:

| Flag | Effect |
|---|---|
| `--profile <name>` | Override the active profile for this invocation only. |
| `--non-interactive` | Fail rather than prompt. Used by CI and any scripted invocation. |
| `--json` | Structured output on commands that produce data (`profile list`, `status`, `doctor`). |
| `--verbose` / `-v` | Wire through to the underlying script / module. |

**Exit codes.** `0` for success and for idempotent no-ops ("already done"). Non-zero only when something actually failed. `doctor` exits `0` only if all checks pass.

**Argument style.** Long flags with `=` or space (`--mode=cloud_sb`, `--mode cloud_sb`). Subcommands are space-separated (`plannen db migrate`).

**Help.** `plannen` with no args prints top-level help. `plannen <verb> --help` prints per-verb help; while a verb is still wrapping a bash script, the help text includes a footer naming the underlying script so users can drop down if needed. The footer is removed when the script is absorbed.

### Profile system

State separation:

- **Repo state** (source code, `node_modules`, `dist/`) — one copy, shared across profiles.
- **Runtime state** (pgdata, photos, env, link state) — per-profile under `~/.plannen/profiles/<name>/`.
- **Active profile pointer** — `PLANNEN_PROFILE` env var if set, otherwise `~/.plannen/active` file. Env wins; file is the persistent default. Missing both → most commands fail loudly; `plannen init` is the exception (auto-creates a profile named `default`).

Disk layout:

```
~/.plannen/
├── active                              # one line: profile name
└── profiles/
    └── <name>/
        ├── profile.json                # {name, mode, port_offset, created_at}
        ├── env                         # PLANNEN_TIER, DATABASE_URL, ports, secrets …
        ├── pgdata/                     # local_pg only
        ├── photos/                     # local_pg only
        ├── supabase/                   # local_sb, cloud_sb link state
        └── vercel/                     # cloud_sb link state
```

`profile.json` is the manifest:

```json
{
  "name": "staging",
  "mode": "cloud_sb",
  "port_offset": 100,
  "created_at": "2026-05-17T14:00:00Z"
}
```

**Env composition.** When the CLI spawns a wrapped script (wrap phase) or runs an absorbed module (absorb phase), it builds the env from this layered stack (later layers override earlier):

1. `process.env`.
2. The profile's `env` file (parsed at startup).
3. CLI-injected vars: `PLANNEN_PROFILE`, `PLANNEN_PROFILE_DIR`, port assignments.
4. Per-command overrides (rare — e.g. `--tier 1` override on a one-off invocation).

The repo's `.env` becomes a **symlink** to `~/.plannen/profiles/<active>/env`. Existing code that reads `./.env` (Vite, backend, MCP) keeps working unchanged. `plannen profile use` rewrites the symlink atomically. On first run, `plannen init` migrates any pre-existing `.env` file's contents into the new profile and replaces the file with the symlink — first-time-user experience stays seamless.

**Port allocation.** Each profile is assigned a `port_offset` at creation time — the smallest unused multiple of `100` across all profiles (`default` gets `0`, next gets `100`, etc.). Concrete ports:

| Process | Base | local_pg | local_sb |
|---|---|---|---|
| Postgres / Supabase DB | 54322 | `54322 + offset` | `54322 + offset` |
| Backend (Hono) | 54323 | `54323 + offset` | n/a |
| Web dev server | 4321 | `4321 + offset` | `4321 + offset` |
| Supabase API | 54321 | n/a | `54321 + offset` |
| Supabase Studio | 54324 | n/a | `54324 + offset` |

The offset is baked into `profile.json` and stays stable across `up`/`down`. `cloud_sb` profiles ignore most of this — only the web dev port matters locally.

**Lifecycle commands.**

- `plannen profile create <name> --mode=<m>` — fails if the name exists; picks port offset; writes `profile.json` and an `env` seeded with `PLANNEN_TIER` + ports. `chmod 600` on `env`.
- `plannen profile use <name>` — flips `~/.plannen/active` and the `.env` symlink. Refuses if any process from the previous profile is still running (suggests `plannen down` first).
- `plannen profile list` — table or `--json`; marks the active row.
- `plannen profile delete <name>` — refuses to delete the active profile; prompts before wiping `pgdata`/`photos` unless `--yes`.

**Migration from today's state.** On first run, `plannen init` (or the first `plannen profile create`) detects existing `~/.plannen/pgdata`, `~/.plannen/photos`, and a real `.env` file. It offers to **move them into a new profile named `default`** (offset 0) so nothing is lost.

### Wrap-then-absorb mechanics

**Wrap (PR1–PR3).** Each command lives in `cli/commands/<verb>.mjs` and exposes `run({ args, profile, env })`. During wrap, the function builds a child env and shells out:

```js
const script = path.join(REPO, 'scripts', map[args.command]);
await spawn('bash', [script, ...passthrough], { env, stdio: 'inherit' });
```

The wrapper translates **flags** but not **behaviour**. The bash files don't move and aren't edited. Example: `plannen db migrate` becomes `node scripts/lib/migrate.mjs` with `DATABASE_URL` and `PLANNEN_TIER` set from the profile.

**Absorb (PR4+).** One PR per logical group. The pattern for each:

1. Extract the script's logic into `cli/lib/<module>.mjs` — pure-ish functions, no top-level side effects.
2. Rewrite the command handler to call that module directly instead of `spawn('bash', …)`.
3. Delete the bash file.
4. Update tests — the wrap-era test asserting "right bash spawned with right env" becomes a unit test on the module plus a thin handler test.
5. Remove the "wraps `scripts/X.sh`" footer from `--help`.

**Boundaries.** Any script that wraps an external CLI (`supabase`, `vercel`, `docker`) keeps shelling out — orchestration moves into JS, the external invocations are via `execa` or `spawn`. The line is "no `.sh` files left in `scripts/`"; external binaries from JS are fine.

**Order of absorption.** Cheapest first:

1. `db.*` — already mostly Node via `migrate.mjs`.
2. `mcp.*` — small scripts.
3. `doctor` — pure check logic.
4. `init` — touches everything; last.

**Backwards-compat shim.** `scripts/bootstrap.sh`, `scripts/start.sh`, `scripts/stop.sh` survive longer as one-liner wrappers: `exec npx plannen init "$@"`, etc. CLAUDE.md keeps pointing at the same names. Removed in a separate post-absorb deprecation PR.

### Cloud staging provisioning

Staging and prod are **two cloud_sb profiles**, conventionally named `staging` and `prod`. Profiles already carry env, link state, and ports — they're the natural unit for "an environment". No separate targets registry.

```
~/.plannen/profiles/
├── default/      mode=local_pg  (your daily dev)
├── staging/      mode=cloud_sb  (staging Supabase + Vercel)
└── prod/         mode=cloud_sb  (real personal data + Vercel)
```

**`plannen cloud provision --profile staging`** is a guided one-time setup:

1. **Pre-flight.** Require `supabase login` and `vercel login`. Refuse if the profile already has Supabase + Vercel link state (suggests `--force`).
2. **Supabase project.** The CLI does **not** create the Supabase project — that's dashboard work (org choice, region, billing tier). It prompts the user to create `plannen-staging` in the Supabase dashboard, then asks for the project ref + DB password. Pulls derived secrets (`SUPABASE_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DATABASE_URL`) via the Management API or `supabase projects api-keys`. Writes them into the profile's `env`.
3. **Apply schema.** `supabase db push --linked` against the staging project — runs every migration in `supabase/migrations/` (skips the Tier-0 overlay; local-only).
4. **Deploy edge functions.** `supabase functions deploy --project-ref <ref>` for each function under `supabase/functions/`.
5. **Vercel project.** Prompts the user to create `plannen-staging` in the Vercel dashboard, then `vercel link --yes --project plannen-staging` against the profile's vercel dir.
6. **Push env to Vercel.** Push the profile's `VITE_*` and `PLANNEN_*` build-time vars into Vercel's production env scope for that project.
7. **First deploy.** `vercel --prod`. Capture the deployment URL.
8. **Wire Auth.** Update Supabase Auth Site URL + redirect allow-list to include the staging deployment URL via the Management API.

Same command with `--profile prod` does the same dance for the prod environment.

**Why provision doesn't create projects programmatically.** Supabase project creation requires org + region + billing decisions; Vercel project creation requires team + framework detection. Both are click-once dashboard tasks. Auto-creating them would trade a clean dashboard step for shaky CLI prompts that hide important choices.

**`plannen promote`.** Two-project Vercel means we can't move an artifact — `VITE_SUPABASE_URL` is baked at build time and differs between staging and prod. So promote is *"replay everything staging did, against prod"*:

1. Read `staging` profile + `prod` profile from disk (CI: from env).
2. **Schema parity check.** Compare the migration list applied on staging vs prod. **Refuse** if prod has a migration staging doesn't (that's an anomaly worth stopping for). Warn if staging has migrations not yet on prod (the expected case — these are about to apply).
3. `supabase db push --linked` against prod.
4. Deploy edge functions to prod.
5. Trigger a fresh Vercel build on the prod project at the current `main` SHA.
6. Wait for the build to finish; print the new prod URL.

Promote is **never automatic** — only `plannen promote` from a shell or a `workflow_dispatch` GitHub Action job.

**Secrets discipline.** The profile's `env` file is `chmod 600` on write. It contains the service role key and DB password for that cloud project. A top-of-`README.md` warning calls out `~/.plannen/profiles/*/env` so it doesn't get shared.

**DB branching out of scope.** Supabase Branching could give per-PR DB branches but it's a much bigger spec. Deferred.

### CI/CD flow

#### Existing workflows stay

- `ci.yml` — test + build on every PR and push. Unchanged.
- `tier-0-bootstrap.yml` — full bootstrap regression on PRs that touch lifecycle/migration surface. After PR1, it invokes `plannen init --non-interactive --mode=local_pg` instead of the bash bootstrap. Behaviour unchanged.

#### New: `release-staging.yml` — auto on merge to `main`

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:           # manual rerun escape hatch

concurrency:
  group: release-staging
  cancel-in-progress: true     # newer main supersedes older
```

Steps:

1. Checkout + Node 20 + `npm ci`.
2. Build the CLI.
3. **Materialize the staging profile from secrets** (synthetic profile mode; see below). No on-disk profile dir.
4. `plannen db migrate --profile staging --non-interactive` — apply pending migrations to staging Supabase. Same parity logic as `promote` — refuses if remote has migrations local doesn't.
5. Deploy Supabase functions to staging.
6. `vercel deploy --prod --token=$STAGING_VERCEL_TOKEN` against the staging project; wait for completion; print URL as a job summary.
7. **Smoke check** — `curl -fsS $STAGING_URL/api/health` (a new health endpoint added as part of PR3). Single ping; not a full suite.

A failure leaves staging in a partial state. We don't auto-rollback — surface the failure loudly so it's fixed forward. Plannen is single-user; blast radius is staging-only.

#### New: `promote-prod.yml` — `workflow_dispatch` only

```yaml
on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'Commit SHA to promote (default: current main)'
        required: false

concurrency:
  group: promote-prod
  cancel-in-progress: false    # never cancel a promote mid-flight

environment: prod-promote      # GitHub Environment with manual-approve gate
```

Steps:

1. Checkout the requested SHA (or `main` HEAD).
2. Materialize both profiles from secrets — staging (read-only, parity check) + prod.
3. `plannen promote --non-interactive` — same code as developer-shell promote, just with profiles sourced from env. Runs the section-5 promote definition end to end.
4. Post the prod URL + commit SHA as the workflow run summary.

**GitHub Environment protection** on the `prod-promote` environment: require manual approval (you approve in the GitHub UI), restrict to `main`, limit to your GitHub user. Even after you click "Run workflow", GitHub waits for the approval before mounting prod secrets.

#### Required GitHub Secrets

| Secret | Used in |
|---|---|
| `STAGING_SUPABASE_PROJECT_REF` | release-staging |
| `STAGING_SUPABASE_ACCESS_TOKEN` | release-staging (Management API) |
| `STAGING_DATABASE_URL` | release-staging |
| `STAGING_SUPABASE_ANON_KEY` | release-staging |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | release-staging |
| `STAGING_VERCEL_TOKEN` | release-staging |
| `STAGING_VERCEL_PROJECT_ID` | release-staging |
| `STAGING_VERCEL_ORG_ID` | release-staging |
| `PROD_*` | promote-prod (same shape, prod project) |

#### Synthetic profile mode

The CLI gains one new capability: when `PLANNEN_PROFILE_FROM_ENV=1` is set, profile resolution skips `~/.plannen/profiles/` entirely and reads everything from `process.env`. The profile name from `--profile <name>` becomes a label for log lines. This is the same code path local users hit; CI just feeds it different inputs. **No CI-specific branching inside the commands themselves.**

## Implementation phases

### PR1 — CLI scaffold + 3 headline verbs (wrap)

- `bin/plannen.mjs` + citty + command dispatcher + tests.
- Verbs: `init`, `up`, `down`, `status`, `--help`, `--version`.
- All three wrap their corresponding bash scripts (`bootstrap.sh`, `start.sh`, `stop.sh`).
- `package.json` bin entry + npm-script alias.
- Test harness pattern (spy on spawn; assert script + env).
- Docs touch-up: `README.md` quick-start switches to `npx plannen init`.
- **No profile system yet** — env source is `process.env` (which dotenv-loads the repo's `.env` as it does today). The profile abstraction lands in PR2 and retrofits PR1's verbs.

### PR2 — Profile system

- `~/.plannen/profiles/` layout + `profile.json` schema.
- `plannen profile create|use|list|delete`.
- `~/.plannen/active` + `PLANNEN_PROFILE` env-var resolution.
- `.env` symlink mechanics.
- Port-offset allocator.
- Migration of existing `~/.plannen/pgdata` + `~/.plannen/photos` + repo `.env` into a `default` profile on first run.
- Every existing verb (from PR1) grows `--profile` flag wiring.

### PR3 — Cloud provisioning + CI/CD + health endpoint

- `plannen cloud provision --profile <name>` (full 8-step flow). New JS, not a wrapper.
- `plannen deploy --mode=cloud_sb` (the on-going deploy, not the initial provision). Replaces `scripts/vercel-deploy.sh` from day one (no wrap phase for this verb — the new code path supersedes the bash script, which is deleted in this PR).
- `plannen promote` (developer-shell + CI).
- `release-staging.yml` workflow.
- `promote-prod.yml` workflow.
- `prod-promote` GitHub Environment configured.
- Synthetic profile mode (`PLANNEN_PROFILE_FROM_ENV=1`).
- Health endpoint at `/api/health` for the smoke check.

### PR4+ — Absorption phases

Each PR ports one logical group:

| PR | Group | Wraps → Absorbs |
|---|---|---|
| PR4 | `db.*` | `scripts/lib/migrate.mjs` (already Node), `export-seed.sh`, `restore-*.sh`, `migrate-tier.sh` |
| PR5 | `mcp.*` | `mcp-mode.sh`, `mcp-rotate-bearer.sh` |
| PR6 | `doctor` | `cloud-doctor.mjs`, plus the plugin's `plannen-doctor` skill checks |
| PR7 | `install.*` | `skills-install.sh`, plugin install (currently inline in bootstrap) |
| PR8 | `init` | `bootstrap.sh` becomes a one-liner shim; the actual logic moves into `cli/lib/init.mjs` |

### Deprecation tail

After PR8, a final PR deletes the `scripts/bootstrap.sh`, `scripts/start.sh`, `scripts/stop.sh` shim wrappers. CLAUDE.md and READMEs are updated to drop the bash names entirely.

## Out of scope

- Publishing `plannen` to the npm registry as a globally installable CLI.
- Supabase DB Branching (per-PR DB previews).
- Automatic rollback on staging deploy failure.
- A Playwright smoke suite against staging (single curl is enough for now).
- A Tier 3 (Plannen SaaS) deployment path.
- Tier 0 → Tier 1 migration (separate spec; tracked in issue #8).

## Open questions

None — all design choices were resolved during brainstorming. Detailed task ordering, test fixtures, and per-module API shapes will be specified by the implementation plan.

## References

- [`docs/TIERED_DEPLOYMENT_MODEL.md`](../../TIERED_DEPLOYMENT_MODEL.md) — Tier 0/1/2 semantics.
- [`docs/superpowers/specs/2026-05-09-bootstrap-and-setup-story-design.md`](./2026-05-09-bootstrap-and-setup-story-design.md) — current `bootstrap.sh` contract.
- [`docs/superpowers/specs/2026-05-16-tier-2-cloud-deploy-design.md`](./2026-05-16-tier-2-cloud-deploy-design.md) — Tier 2 cloud deploy mechanics this CLI inherits.
- [`docs/superpowers/specs/2026-05-17-tier-2-bootstrap-automation-design.md`](./2026-05-17-tier-2-bootstrap-automation-design.md) — current bootstrap automation surface.
- [citty](https://github.com/unjs/citty) — CLI parser library choice.
