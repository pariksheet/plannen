// Plannen init orchestrator — JS port of scripts/bootstrap.sh.
//
// Step numbering, user-visible output, and idempotency guarantees mirror the
// bash original. The orchestrator shells out to the existing per-process
// scripts (pg-start.sh, local-start.sh, functions-start.sh, etc.) and to the
// existing helper Node scripts (migrate.mjs, snapshot.mjs, plannen-pg.mjs,
// migrate-tier0-to-tier1.mjs, migrate-tier1-to-tier2.mjs, auth-user.mjs,
// claude-desktop-config.mjs, cloud-doctor.mjs, restore-seed.mjs, restore-photos.mjs).
//
// All side-effect surfaces are dep-injectable via the ctx parameter, matching
// the pattern in cli/commands/cloud/provision.mjs and cli/commands/promote.mjs.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  colorPalette,
  dim,
  envGet,
  envSet,
  err,
  lower,
  mergeEnv,
  ok,
  pidAlive,
  reconcileMcpPluginJsonToStdio,
  requireDockerRunning,
  requireVersion,
  step,
  warn,
} from './init-helpers.mjs';
import { ensureProfile as defaultEnsureProfile } from './ensure-profile.mjs';
import { composeEnv, getProfileEnvPath, profileExists, readManifest, resolveActiveProfile } from './profiles.mjs';
import { ensureVapidKeys } from './ensure-vapid.mjs';
import { buildPoolerUrl } from '../../scripts/lib/cloud-db-url.mjs';
import { portOwner as defaultPortOwner, describePortSquatter } from '../../scripts/lib/port-owner.mjs';
import { readSeedWatermark } from '../../scripts/lib/seed-watermark.mjs';
import * as supabaseMgmt from '../../scripts/lib/supabase-mgmt.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

const MODE_TO_TIER = {
  local_pg: '0',
  local_sb: '1',
  cloud_sb: '2',
  tier0: '0',
  tier1: '1',
  tier2: '2',
};

const TO_CANONICAL = {
  local_pg: 'local_pg',
  local_sb: 'local_sb',
  cloud_sb: 'cloud_sb',
  tier0: 'local_pg',
  tier1: 'local_sb',
  tier2: 'cloud_sb',
};

// Default subprocess runner — inherits stdio so the user sees raw output.
function defaultSpawn(cmd, args, opts = {}) {
  // Returns a Promise<number> exit code. Mirrors runScript.mjs behaviour for
  // signal handling so SIGINT'd children produce a deterministic exit code.
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code, signal) => {
      if (signal) {
        const sigNum = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1;
        resolve(128 + sigNum);
      } else {
        resolve(code ?? 1);
      }
    });
    child.on('error', () => resolve(1));
  });
}

function defaultSpawnSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// Read one line from stdin / a tty. Mirrors bash `read -r answer`. Falls back
// to /dev/tty when stdin is redirected (matches the bash `< /dev/tty` reads).
async function defaultPrompt(promptText, { secret = false } = {}) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    if (secret) {
      // No-echo not natively supported in node readline; rely on the user's
      // terminal echo behaviour. For password-style prompts in bootstrap.sh,
      // bash flips stty -echo; we approximate by toggling stdin raw mode.
      try { process.stdin.setRawMode && process.stdin.setRawMode(true); } catch {}
    }
    rl.once('line', (line) => {
      if (secret) {
        try { process.stdin.setRawMode && process.stdin.setRawMode(false); } catch {}
        process.stdout.write('\n');
      }
      rl.close();
      resolve(line);
    });
  });
}

// Probe a TCP port for readiness — used to wait for embedded Postgres on 54322.
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch {}
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.once('timeout', () => finish(false));
    s.connect(port, host);
  });
}

async function waitForPort(host, port, attempts) {
  for (let i = 0; i < attempts; i++) {
    if (await probePort(host, port)) return true;
    await sleep(1000);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The full init orchestrator. Returns 0 on success, non-zero on failure.
 *
 * ctx fields (all optional unless noted):
 *   env            — base env (default: process.env)
 *   repoRoot       — project root (default: resolved from this file)
 *   spawn          — async (cmd, args, opts) → exitCode; default inherits stdio
 *   spawnSync      — (cmd, args, opts) → { status, stdout, stderr }; default real
 *   spawnBg        — (cmd, args, opts) → { pid }; default: detached nohup-style
 *   prompt         — async (text, { secret }) → string; default: readline
 *   log            — { ok, err, warn, step, dim } overrides (default helpers)
 *   ensureProfile  — default cli/lib/ensure-profile.mjs
 *   waitForPort    — async (host, port, attempts) → boolean
 *   fetch          — global fetch override (for Supabase Management API in Tier 2)
 *   supabaseMgmtImpl — override for tests
 */
export async function invokeInit(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;

  // `--mode` may be omitted when the target profile already exists — fall back
  // to the profile's manifest mode so the user doesn't have to retype what
  // they already declared at `profile create` time.
  let mode = rawArgs.mode;
  if (!mode) {
    const targetProfile = rawArgs.profile ?? resolveActiveProfile(baseEnv) ?? 'default';
    if (profileExists(targetProfile, baseEnv)) {
      const m = readManifest(targetProfile, baseEnv);
      if (m && m.mode) mode = m.mode;
    }
  }
  if (!mode || !(mode in MODE_TO_TIER)) {
    throw new Error(
      `init: --mode is required (no existing profile to derive it from). Must be one of: ${Object.keys(MODE_TO_TIER).join(', ')}`,
    );
  }

  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  const spawn = ctx.spawn ?? defaultSpawn;
  const sspawn = ctx.spawnSync ?? defaultSpawnSync;
  const spawnBg = ctx.spawnBg ?? defaultSpawnBg;
  const prompt = ctx.prompt ?? defaultPrompt;
  const ensure = ctx.ensureProfile ?? defaultEnsureProfile;
  const wait = ctx.waitForPort ?? waitForPort;
  const whoHoldsPort = ctx.portOwner ?? defaultPortOwner;
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const mgmt = ctx.supabaseMgmtImpl ?? supabaseMgmt;
  const logImpl = makeLog(ctx.log);

  const tier = MODE_TO_TIER[mode];
  const argEmail = rawArgs.email;
  const nonInteractive = Boolean(rawArgs['non-interactive'] ?? rawArgs.nonInteractive);
  const installPlugin = Boolean(rawArgs['install-plugin']);
  const startDev = Boolean(rawArgs['start-dev']);
  const configureDesktop = Boolean(rawArgs['configure-desktop']);
  const installSkills = Boolean(rawArgs['install-skills']);
  const argProjectRef = rawArgs['project-ref'] ?? '';
  const argCloudDbUrl = rawArgs['cloud-db-url'] ?? '';
  const forceOverwrite = Boolean(rawArgs['force-overwrite']);
  const acceptStorageQuota = Boolean(rawArgs['accept-storage-quota']);
  const skipPhotos = Boolean(rawArgs['skip-photos']);
  const skipVercel = Boolean(rawArgs['skip-vercel']);

  // ── 0. Tier-change detection ───────────────────────────────────────────────
  // Read OLD_TIER from the existing .env *before* ensureProfile rewrites
  // anything. The profile-create path migrates the legacy .env into the
  // profile env, overwriting PLANNEN_TIER with the *new* mode — so reading
  // after ensureProfile would always see oldTier === newTier.
  const envFile = path.join(repoRoot, '.env');
  const exampleFile = path.join(repoRoot, '.env.example');
  let oldTier = '';
  if (existsSync(envFile)) {
    oldTier = envGet(envFile, 'PLANNEN_TIER') ?? '';
  }

  // ── Profile bootstrap (PR2 contract) ──────────────────────────────────────
  // Default to the active profile when present, falling back to 'default' for
  // the first-install / no-profile case. Mirrors how up/down/status resolve.
  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv) ?? 'default';
  const canonicalMode = TO_CANONICAL[mode];
  const ensured = ensure({ name: profileName, mode: canonicalMode, env: baseEnv, repoRoot });
  const composed = composeEnv(profileName, {}, baseEnv);
  // Honor the profile's port assignments (offsets) for every Tier 0 process.
  // Hardcoded ports here caused cross-profile bleed (#13).
  const pgPort = Number(composed.PLANNEN_PG_PORT ?? 54322);
  const backendPort = String(composed.PLANNEN_BACKEND_PORT ?? '54323');
  // Write env changes to the profile's own file, never through the repo .env
  // symlink — the symlink tracks the *active* profile, which may differ (#13).
  const profileEnvFile = getProfileEnvPath(profileName, baseEnv);
  if (ensured && ensured.symlinkSkipped) {
    const active = resolveActiveProfile(baseEnv);
    logImpl.warn(
      `profile '${profileName}' is not the active profile ('${active}') — .env stays pointed at '${active}'. ` +
      `Run 'npx plannen profile use ${profileName}' to switch.`,
    );
  }
  // PRE_TIER captures the tier as observed before any .bak restore; used by
  // dev-server restart logic.
  const preTier = oldTier;
  let tierChange = '';

  if (oldTier === '0' && tier === '1' && existsSync(path.join(os.homedir(), '.plannen', 'pgdata'))) {
    tierChange = '0->1';
  }
  if (oldTier === '1' && tier === '2') {
    tierChange = '1->2';
  }
  if (oldTier === '0' && tier === '2') {
    logImpl.err(`Tier 0 → Tier 2 is not a direct path; run 'plannen init --mode=local_sb' first, then '--mode=cloud_sb'.`);
    return 1;
  }

  // Tier 2 → Tier 1 reverse path: restore the pre-migration backups in place.
  if (oldTier === '2' && tier === '1') {
    tierChange = '2->1';
    const envBak = path.join(repoRoot, '.env.tier1.bak');
    if (existsSync(envBak)) {
      copyFileSync(envBak, profileEnvFile);
      logImpl.ok('restored profile env from .env.tier1.bak (Tier 2 → Tier 1)');
    }
    const pluginJsonBak = path.join(repoRoot, 'plugin/.claude-plugin/plugin.json.tier1.bak');
    if (existsSync(pluginJsonBak)) {
      copyFileSync(pluginJsonBak, path.join(repoRoot, 'plugin/.claude-plugin/plugin.json'));
      logImpl.ok('restored plugin.json from plugin.json.tier1.bak');
    }
    const progressFile = path.join(repoRoot, '.plannen-tier2-progress');
    if (existsSync(progressFile)) rmSync(progressFile, { force: true });
    logImpl.dim('  cloud project still exists; not synced back. Re-run --mode=cloud_sb to return.');
    // Re-read OLD_TIER from restored .env so the rest of init behaves as if
    // we'd never been on Tier 2.
    oldTier = existsSync(profileEnvFile) ? (envGet(profileEnvFile, 'PLANNEN_TIER') ?? '') : '';
  }

  const snapshotDir = path.join(repoRoot, '.plannen', 'snapshots');
  const tier0SidePort = String(baseEnv.PLANNEN_PG_MIGRATION_PORT ?? '54422');

  // Seed local plugin manifest on first run.
  const pluginJsonPath = path.join(repoRoot, 'plugin/.claude-plugin/plugin.json');
  const pluginJsonExamplePath = path.join(repoRoot, 'plugin/.claude-plugin/plugin.json.example');
  if (!existsSync(pluginJsonPath) && existsSync(pluginJsonExamplePath)) {
    copyFileSync(pluginJsonExamplePath, pluginJsonPath);
  }

  // ── 1. Pre-flight ──────────────────────────────────────────────────────────
  logImpl.step(`1. Pre-flight checks (Tier ${tier})`);
  let fail = false;
  if (!requireVersion({
    bin: 'node', min: '20.0',
    extract: ['node', '--version'],
    hint: 'Install Node.js >= 20 LTS — https://nodejs.org or via nvm/asdf/volta',
    log: logImpl, run: sspawn,
  })) fail = true;
  if (tier === '1' || tierChange === '1->2') {
    if (!requireDockerRunning({ run: sspawn, log: logImpl })) fail = true;
  }
  if (tier === '1' || tier === '2') {
    if (!requireVersion({
      bin: 'supabase', min: '2.0',
      extract: ['supabase', '--version'],
      hint: 'macOS:  brew install supabase/tap/supabase\nLinux:  https://supabase.com/docs/guides/cli/getting-started',
      log: logImpl, run: sspawn,
    })) fail = true;
  }
  if (tier === '0') {
    logImpl.dim('Tier 0 — skipping Docker and Supabase CLI checks (embedded Postgres only)');
  }
  // claude is optional — only used in step 9.
  const claudeProbe = sspawn('which', ['claude']);
  const claudePresent = (claudeProbe.status ?? 1) === 0;
  if (claudePresent) {
    logImpl.ok('claude (optional, for plugin install)');
  } else {
    logImpl.warn('claude CLI not found — step 9 will print manual install instructions');
  }
  if (fail) {
    logImpl.err('Pre-flight checks failed. Resolve above and re-run.');
    return 1;
  }

  // ── 2. Email cascade ───────────────────────────────────────────────────────
  logImpl.step('2. Identifying your Plannen user');
  const existingEmail = envGet(profileEnvFile, 'PLANNEN_USER_EMAIL');
  const gitEmailRes = sspawn('git', ['config', 'user.email']);
  const gitEmail = ((gitEmailRes.stdout ?? '').trim()) || '';

  let email = '';
  if (argEmail) {
    email = lower(argEmail);
    logImpl.ok(`Using --email ${email}`);
  } else if (existingEmail) {
    email = existingEmail;
    logImpl.ok(`Using existing PLANNEN_USER_EMAIL=${email} from .env`);
  } else if (nonInteractive) {
    logImpl.err('--non-interactive requires --email or PLANNEN_USER_EMAIL in .env');
    return 1;
  } else {
    email = await confirmEmail(gitEmail, prompt, logImpl);
    email = lower(email);
    logImpl.ok(`Confirmed: ${email}`);
  }

  // Spawn-helper that injects the composed profile env. Used for every spawn
  // call below (except where a step needs a custom env). Mirrors how runScript
  // injected env in the old `init.mjs`.
  const childEnv = { ...process.env, ...composed };
  const cspawn = (cmd, args, opts = {}) =>
    spawn(cmd, args, { ...opts, env: { ...childEnv, ...(opts.env ?? {}) } });

  // ── 3. Dependencies ────────────────────────────────────────────────────────
  logImpl.step('3. Installing dependencies');
  // Root install — prefer the silent path when a lockfile + node_modules exist.
  {
    const args = (existsSync(path.join(repoRoot, 'package-lock.json'))
                  && existsSync(path.join(repoRoot, 'node_modules')))
      ? ['install', '--silent'] : ['install'];
    const c = await cspawn('npm', args, { cwd: repoRoot });
    if (c !== 0) { logImpl.err(`root npm install failed (exit ${c})`); return c; }
  }
  logImpl.ok('root npm install');
  // mcp/ install + build (subshell).
  {
    const c1 = await cspawn('npm', ['install', '--silent'], { cwd: path.join(repoRoot, 'mcp') });
    if (c1 !== 0) { logImpl.err(`mcp npm install failed (exit ${c1})`); return c1; }
    const c2 = await cspawn('npm', ['run', 'build', '--silent'], { cwd: path.join(repoRoot, 'mcp') });
    if (c2 !== 0) { logImpl.err(`mcp build failed (exit ${c2})`); return c2; }
  }
  logImpl.ok('mcp/ install + build');

  // ── Tier 2 branch (cloud) ──────────────────────────────────────────────────
  if (tier === '2') {
    return runTier2({
      rawArgs: { argProjectRef, argCloudDbUrl, forceOverwrite, acceptStorageQuota, skipPhotos, skipVercel, nonInteractive, startDev },
      ctx: {
        spawn: cspawn, sspawn, prompt, mgmt, fetch: fetchImpl, log: logImpl,
        write: ctx.writeRaw ?? ((s) => process.stdout.write(s)),
      },
      env: { repoRoot, envFile: profileEnvFile, exampleFile, email, tierChange },
    });
  }

  // ── 4. DB + migrations + user row ──────────────────────────────────────────
  const databaseUrlTier0 = `postgres://plannen:plannen@127.0.0.1:${pgPort}/plannen`;
  let userUuid = '';
  let supabaseUrlForNode = '';
  let serviceRoleForNode = '';

  if (tier === '0') {
    logImpl.step('4. Starting embedded Postgres (Tier 0)');
    mkdirSync(path.join(os.homedir(), '.plannen'), { recursive: true });
    // Per-profile pid/log paths when the profile seeds them (#7).
    const pgPidPath = composed.PLANNEN_PG_PID ?? path.join(os.homedir(), '.plannen', 'pg.pid');
    const pgLogPath = composed.PLANNEN_PG_LOG ?? path.join(os.homedir(), '.plannen', 'pg.log');
    mkdirSync(path.dirname(pgPidPath), { recursive: true });
    // A foreign listener on our port (colima/Docker forward, another stack)
    // answers connects meant for the embedded pg and corrupts migrations with
    // confusing auth errors. Identify it and refuse up front (#14).
    const squatter = whoHoldsPort(pgPort);
    if (pidAlive(pgPidPath)) {
      const pid = readFileSync(pgPidPath, 'utf8').trim();
      logImpl.dim(`embedded Postgres already running (pid ${pid})`);
      if (squatter && !/postgres/i.test(squatter.command)) {
        logImpl.err(describePortSquatter(pgPort, squatter));
        return 1;
      }
      // The pid file is global — the running instance may belong to a profile
      // on a different port offset. Refuse to migrate the wrong DB (#13).
      const up = await wait('127.0.0.1', pgPort, 5);
      if (!up) {
        logImpl.err(
          `embedded Postgres (pid ${pid}) is not listening on this profile's port ${pgPort} — ` +
          `it likely belongs to another profile. Stop it ('npx plannen down') or init the profile that owns it.`,
        );
        return 1;
      }
    } else {
      if (squatter) {
        logImpl.err(describePortSquatter(pgPort, squatter));
        return 1;
      }
      // `init` is the idempotent entry — initdb's on first run, then keeps pg
      // and supervisor alive. Background it; record the pid for pg-stop.sh.
      spawnBg(
        'node',
        [path.join(repoRoot, 'scripts/lib/plannen-pg.mjs'), 'init'],
        { cwd: repoRoot, logPath: pgLogPath, env: { ...process.env, ...composed } },
      );
      const up = await wait('127.0.0.1', pgPort, 15);
      if (!up) {
        logImpl.err(`embedded Postgres did not come up on ${pgPort} — tail ${pgLogPath}`);
        return 1;
      }
    }
    logImpl.ok(`embedded Postgres on ${pgPort}`);

    // Replay-aware migration bound (#16): a data-only seed dump applies
    // cleanly only to the schema it was exported from. When a watermarked
    // seed might be restored, migrate up to the watermark first; the
    // remaining migrations run after the restore (step 5d).
    const seedSql = path.join(repoRoot, 'supabase/seed.sql');
    const seedPhotos = path.join(repoRoot, 'supabase/seed-photos.tar.gz');
    const seedWatermark = existsSync(seedSql)
      ? readSeedWatermark(readFileSync(seedSql, 'utf8'))
      : null;

    logImpl.step('5. Applying migrations (Tier 0 overlay + main)');
    {
      const args = [path.join(repoRoot, 'scripts/lib/migrate.mjs')];
      if (seedWatermark) args.push('--to', seedWatermark);
      const c = await spawn(
        'node', args,
        { cwd: repoRoot, env: { ...process.env, ...composed, DATABASE_URL: databaseUrlTier0, PLANNEN_TIER: '0' } },
      );
      if (c !== 0) { logImpl.err(`migrations failed (exit ${c})`); return c; }
    }
    logImpl.ok(seedWatermark ? `migrations applied up to seed watermark ${seedWatermark}` : 'migrations applied');
    if (existsSync(seedSql)) {
      // Count plannen.users to decide whether to restore. Use a tiny inline JS
      // probe via spawnSync so we don't pull pg directly into this module.
      const count = await readUserCount(databaseUrlTier0, sspawn, repoRoot);
      if (count === 0) {
        logImpl.step('5b. Restoring supabase/seed.sql into empty DB');
        const c = await spawn(
          'node', [path.join(repoRoot, 'scripts/lib/restore-seed.mjs'), seedSql],
          { cwd: repoRoot, env: { ...process.env, ...composed, DATABASE_URL: databaseUrlTier0 } },
        );
        if (c !== 0) {
          // The seed is an optional convenience restore — a pg_dump taken at
          // export time. After schema migrations it can stop applying cleanly
          // (e.g. dropped columns). The DB was empty, so continuing with a
          // fresh one loses nothing; the dump stays on disk untouched.
          logImpl.warn(
            `seed restore failed (exit ${c}) — likely a backup from an older schema. ` +
            `Continuing with an empty DB; your data is still in ${path.relative(repoRoot, seedSql)}.`,
          );
        } else {
          logImpl.ok('seed restored');
          if (existsSync(seedPhotos)) {
            logImpl.step('5c. Restoring photos from supabase/seed-photos.tar.gz');
            const c2 = await spawn(
              'node', [path.join(repoRoot, 'scripts/lib/restore-photos.mjs'), seedPhotos],
              { cwd: repoRoot, env: { ...process.env, ...composed } },
            );
            if (c2 !== 0) { logImpl.err(`photos restore failed (exit ${c2})`); return c2; }
            logImpl.ok('photos restored');
          }
        }
      } else {
        logImpl.dim(`DB already has ${count} plannen.users row(s) — skipping seed restore`);
      }
    }

    // 5d. Replay tail (#16): apply the migrations deferred past the seed
    // watermark, migrating the freshly-restored data forward to head. Runs
    // regardless of restore outcome so the schema always ends at head.
    if (seedWatermark) {
      logImpl.step('5d. Applying migrations beyond the seed watermark');
      const c = await spawn(
        'node', [path.join(repoRoot, 'scripts/lib/migrate.mjs')],
        { cwd: repoRoot, env: { ...process.env, ...composed, DATABASE_URL: databaseUrlTier0, PLANNEN_TIER: '0' } },
      );
      if (c !== 0) { logImpl.err(`post-restore migrations failed (exit ${c})`); return c; }
      logImpl.ok('schema at head');
    }

    logImpl.step(`6. Inserting Plannen user row for ${email}`);
    userUuid = await insertAuthUser(databaseUrlTier0, email, sspawn, repoRoot);
    if (!userUuid) {
      logImpl.err('failed to insert user row');
      return 1;
    }
    logImpl.ok(`plannen user: ${userUuid}`);
  } else {
    // Tier 1 path (with optional 0→1 dance).
    if (tierChange === '0->1') {
      logImpl.step('3a. Snapshotting Tier 0 before switching to Tier 1 (auto-backup)');
      mkdirSync(snapshotDir, { recursive: true });
      // Tier 0 PG might already be stopped; bring it up on its native port for
      // the dump. pg-start.sh is idempotent.
      if (!(await probePort('127.0.0.1', pgPort))) {
        const c = await spawn('bash', [path.join(repoRoot, 'scripts/pg-start.sh')], { cwd: repoRoot, env: { ...process.env, ...composed } });
        if (c !== 0) { logImpl.err(`pg-start failed (exit ${c})`); return c; }
        await wait('127.0.0.1', pgPort, 8);
      }
      {
        const c = await spawn(
          'node', [path.join(repoRoot, 'scripts/lib/snapshot.mjs'), '--tier', '0', '--out', snapshotDir, '--keep', '5'],
          { cwd: repoRoot, env: { ...process.env, ...composed } },
        );
        if (c !== 0) { logImpl.err(`Tier 0 snapshot failed (exit ${c})`); return c; }
      }
      {
        const c = await spawn('bash', [path.join(repoRoot, 'scripts/pg-stop.sh')], { cwd: repoRoot });
        // Best-effort stop; allow non-zero (e.g. nothing running) without halting.
        if (c !== 0) logImpl.warn(`pg-stop returned ${c} (continuing)`);
      }
      // Tier 0 PG must be stopped before Tier 1's Docker binds 54322.
      await sleep(1000);
      logImpl.ok(`Tier 0 snapshot saved under ${snapshotDir}`);
    }

    logImpl.step('4. Starting local Supabase');
    {
      const c = await spawn('bash', [path.join(repoRoot, 'scripts/local-start.sh')], { cwd: repoRoot, env: { ...process.env, ...composed } });
      if (c !== 0) { logImpl.err(`local-start failed (exit ${c})`); return c; }
    }

    logImpl.step('5. Applying migrations');
    {
      const c = await spawn('supabase', ['migration', 'up'], { cwd: repoRoot, env: { ...process.env, ...composed } });
      if (c !== 0) { logImpl.err(`supabase migration up failed (exit ${c})`); return c; }
    }
    logImpl.ok('migrations applied');

    logImpl.step(`6. Resolving auth.users row for ${email}`);
    supabaseUrlForNode = envGet(exampleFile, 'SUPABASE_URL') ?? '';
    serviceRoleForNode = envGet(exampleFile, 'SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const existingUrl = envGet(profileEnvFile, 'SUPABASE_URL');
    const existingKey = envGet(profileEnvFile, 'SUPABASE_SERVICE_ROLE_KEY');
    if (existingUrl) supabaseUrlForNode = existingUrl;
    if (existingKey) serviceRoleForNode = existingKey;

    const authRes = sspawn(
      'node',
      [path.join(repoRoot, 'scripts/lib/auth-user.mjs'), email],
      {
        cwd: repoRoot,
        env: {
          ...process.env, ...composed,
          SUPABASE_URL: supabaseUrlForNode,
          SUPABASE_SERVICE_ROLE_KEY: serviceRoleForNode,
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    if (authRes.status === 2) {
      // auth-user.mjs signals "single-user-per-instance refusal" with exit 2.
      // Bash bubbled this up verbatim. Match that.
      return 2;
    }
    if (authRes.status !== 0) {
      logImpl.err('auth-user step failed');
      return 1;
    }
    userUuid = (authRes.stdout ?? '').trim();
    logImpl.ok(`auth user: ${userUuid}`);

    if (tierChange === '0->1') {
      logImpl.step('6b. Snapshotting empty Tier 1 (auto-backup)');
      {
        const c = await spawn(
          'node', [path.join(repoRoot, 'scripts/lib/snapshot.mjs'), '--tier', '1', '--out', snapshotDir, '--keep', '5'],
          { cwd: repoRoot, env: { ...process.env, ...composed } },
        );
        if (c !== 0) { logImpl.err(`Tier 1 snapshot failed (exit ${c})`); return c; }
      }
      logImpl.ok('Tier 1 snapshot saved');

      logImpl.step('6c. Migrating Tier 0 data → Tier 1');
      // Bring Tier 0 PG up on a side port so it doesn't fight Tier 1's Docker.
      {
        const c = await spawn('bash', [path.join(repoRoot, 'scripts/pg-start.sh')], {
          cwd: repoRoot,
          env: { ...process.env, ...composed, PLANNEN_PG_PORT: tier0SidePort },
        });
        if (c !== 0) { logImpl.err(`pg-start (side port) failed (exit ${c})`); return c; }
      }
      const sideUp = await wait('127.0.0.1', Number(tier0SidePort), 8);
      if (!sideUp) {
        logImpl.err(`Tier 0 PG did not come up on side port ${tier0SidePort} — tail ${os.homedir()}/.plannen/pg.log`);
        return 1;
      }

      {
        const c = await spawn(
          'node', [path.join(repoRoot, 'scripts/lib/migrate-tier0-to-tier1.mjs')],
          {
            cwd: repoRoot,
            env: {
              ...process.env, ...composed,
              DATABASE_URL_TIER0: `postgres://plannen:plannen@127.0.0.1:${tier0SidePort}/plannen`,
              DATABASE_URL_TIER1: 'postgres://supabase_admin:postgres@127.0.0.1:54322/postgres',
              SUPABASE_URL: supabaseUrlForNode,
              SUPABASE_SERVICE_ROLE_KEY: serviceRoleForNode,
            },
          },
        );
        if (c !== 0) { logImpl.err(`migrate-tier0-to-tier1 failed (exit ${c})`); return c; }
      }

      await spawn('bash', [path.join(repoRoot, 'scripts/pg-stop.sh')], { cwd: repoRoot });
      logImpl.ok(`Tier 0 data migrated to Tier 1; restore points in ${snapshotDir}`);
    }
  }

  // ── 7. Write profile env ───────────────────────────────────────────────────
  // Always write to the profile's own env file — when the profile is active,
  // the repo .env symlink resolves to the same file; when it isn't, writing
  // through .env would corrupt the active profile's env (#13).
  logImpl.step('7. Writing profile env');
  mergeEnv(exampleFile, profileEnvFile);
  envSet(profileEnvFile, 'PLANNEN_USER_EMAIL', email);
  envSet(profileEnvFile, 'PLANNEN_TIER', tier);
  if (tier === '0') {
    envSet(profileEnvFile, 'DATABASE_URL', databaseUrlTier0);
    envSet(profileEnvFile, 'PLANNEN_BACKEND_PORT', backendPort);
    envSet(profileEnvFile, 'BACKEND_URL', `http://127.0.0.1:${backendPort}`);
    envSet(profileEnvFile, 'VITE_PLANNEN_TIER', '0');
    envSet(profileEnvFile, 'VITE_PLANNEN_BACKEND_MODE', 'plannen-api');
  } else {
    envSet(profileEnvFile, 'DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
    envSet(profileEnvFile, 'VITE_PLANNEN_TIER', '1');
    envSet(profileEnvFile, 'VITE_PLANNEN_BACKEND_MODE', 'supabase');
  }
  logImpl.ok(`profile env for '${profileName}' updated (existing values preserved)`);

  // Generate VAPID keys for Web Push (PWA). Idempotent — only writes if missing.
  // Push works out-of-the-box on Tier 0/1; Tier 2 needs the same keys mirrored
  // into Vercel env (printed in step 16 there).
  await ensureVapidKeys({ envFile: profileEnvFile, email, log: logImpl });

  // Keep the active profile's manifest.mode aligned with PLANNEN_TIER. Best-
  // effort — silent no-op when the profile system isn't engaged.
  await spawn('node', [path.join(repoRoot, 'scripts/lib/sync-profile-mode.mjs')], {
    cwd: repoRoot, env: { ...process.env, ...composed },
  });

  // 7b. Reconcile MCP plugin.json with the target tier. Resets http/cloud →
  // stdio whenever we're targeting a local tier, regardless of oldTier.
  reconcileMcpPluginJsonToStdio({
    pluginJsonPath,
    targetTier: tier,
    repoRoot,
    log: logImpl,
    run: sspawn,
  });

  // Mirror supabase/functions/.env scaffolding.
  const functionsEnv = path.join(repoRoot, 'supabase/functions/.env');
  const functionsEnvExample = `${functionsEnv}.example`;
  if (!existsSync(functionsEnv) && existsSync(functionsEnvExample)) {
    copyFileSync(functionsEnvExample, functionsEnv);
    logImpl.ok(`${path.relative(repoRoot, functionsEnv)} created from template (Google OAuth blank — add via /plannen-setup)`);
  }

  // ── 8. Backend / functions ─────────────────────────────────────────────────
  if (tier === '1') {
    logImpl.step('8. Starting supabase functions serve in background');
    {
      const c = await spawn('bash', [path.join(repoRoot, 'scripts/functions-start.sh')], { cwd: repoRoot, env: { ...process.env, ...composed } });
      if (c !== 0) { logImpl.warn(`functions-start returned ${c}`); }
    }
  } else {
    logImpl.step('8. Building + starting Plannen backend (Tier 0)');
    {
      const c1 = await spawn('npm', ['install', '--silent'], { cwd: path.join(repoRoot, 'backend') });
      if (c1 !== 0) { logImpl.err(`backend npm install failed (exit ${c1})`); return c1; }
      const c2 = await spawn('npm', ['run', 'build', '--silent'], { cwd: path.join(repoRoot, 'backend') });
      if (c2 !== 0) { logImpl.err(`backend build failed (exit ${c2})`); return c2; }
    }
    logImpl.ok('backend built');
    {
      const c = await spawn('bash', [path.join(repoRoot, 'scripts/backend-start.sh')], {
        cwd: repoRoot,
        // PLANNEN_ENV_PATH: the backend rewrites PLANNEN_USER_EMAIL there on
        // web signup — must be this profile's env, not the .env symlink (#13).
        env: { ...process.env, ...composed, PLANNEN_ENV_PATH: profileEnvFile },
      });
      if (c !== 0) logImpl.warn(`backend-start returned ${c}`);
    }
  }

  // ── 8b. Dev server ─────────────────────────────────────────────────────────
  logImpl.step('8b. Web app dev server (npm run dev)');
  let doDev = false;
  if (nonInteractive) {
    if (startDev) doDev = true;
    else logImpl.dim('skipping dev server (--non-interactive without --start-dev)');
  } else {
    const ans = await prompt('  Start npm run dev in the background now? [Y/n]: ');
    const a = lower(ans);
    if (a === '' || a === 'y' || a === 'yes') doDev = true;
    else logImpl.dim('skipped — start later with: bash scripts/dev-start.sh');
  }
  if (doDev) {
    // Tier-change restart: dev-start.sh is idempotent and won't restart a live
    // server. Force a restart when the tier just changed so vite re-reads .env.
    const devPidPath = path.join(repoRoot, '.plannen', 'dev.pid');
    if (preTier && preTier !== tier && existsSync(devPidPath)) {
      logImpl.dim(`tier changed (${preTier} → ${tier}) — restarting dev server so vite re-reads .env`);
      await spawn('bash', [path.join(repoRoot, 'scripts/dev-stop.sh')], { cwd: repoRoot });
    }
    const c = await spawn('bash', [path.join(repoRoot, 'scripts/dev-start.sh')], { cwd: repoRoot, env: { ...process.env, ...composed } });
    if (c !== 0) logImpl.warn(`dev-start returned ${c}`);
  }

  // ── 9. Plugin install (Claude Code) ────────────────────────────────────────
  logImpl.step('9. Claude Code plugin install');
  let doInstall = false;
  if (claudePresent) {
    if (nonInteractive) {
      if (installPlugin) doInstall = true;
      else logImpl.dim('skipping plugin install (--non-interactive without --install-plugin)');
    } else {
      const ans = await prompt('  Install Claude Code plugin now? [Y/n]: ');
      const a = lower(ans);
      if (a === '' || a === 'y' || a === 'yes') doInstall = true;
      else logImpl.dim('skipped — install later with: claude plugin marketplace add ./ && claude plugin install plannen@plannen');
    }
    if (doInstall) {
      // Two-step: add marketplace (idempotent), then install plugin.
      const addRes = sspawn('claude', ['plugin', 'marketplace', 'add', './'], { cwd: repoRoot });
      const addOut = (addRes.stdout ?? '') + (addRes.stderr ?? '');
      if (!/Successfully added|already exists|already added/.test(addOut)) {
        // Re-run to surface the actual error if it wasn't benign.
        await spawn('claude', ['plugin', 'marketplace', 'add', './'], { cwd: repoRoot });
      }
      const inst = await spawn('claude', ['plugin', 'install', 'plannen@plannen'], { cwd: repoRoot });
      if (inst === 0) logImpl.ok('plugin installed');
      else logImpl.warn('plugin install failed; from inside a Claude Code session run: /plugin install plannen@plannen');
    }
  } else {
    logImpl.dim('Claude Code not detected. To install the plugin later:');
    logImpl.dim('  1. Install Claude Code:  https://claude.com/claude-code');
    logImpl.dim("  2. From this repo's root:");
    logImpl.dim('       claude plugin marketplace add ./');
    logImpl.dim('       claude plugin install plannen@plannen');
  }

  // ── 10. Claude Desktop config ──────────────────────────────────────────────
  logImpl.step('10. Claude Desktop MCP config');
  let desktopDir = '';
  if (process.platform === 'darwin') desktopDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  else if (process.platform === 'linux') desktopDir = path.join(os.homedir(), '.config', 'Claude');

  if (desktopDir && existsSync(desktopDir)) {
    const absMcpPath = path.join(repoRoot, 'mcp/dist/index.js');
    const desktopConfig = path.join(desktopDir, 'claude_desktop_config.json');
    let doDesktop = false;
    if (nonInteractive) {
      if (configureDesktop) doDesktop = true;
      else logImpl.dim('skipping Claude Desktop config (--non-interactive without --configure-desktop)');
    } else {
      const ans = await prompt('  Detected Claude Desktop. Merge plannen MCP entry into claude_desktop_config.json now? [Y/n]: ');
      const a = lower(ans);
      if (a === '' || a === 'y' || a === 'yes') doDesktop = true;
      else logImpl.dim(`skipped — re-run bootstrap or manually edit ${desktopConfig}`);
    }
    if (doDesktop) {
      if (!existsSync(absMcpPath)) {
        logImpl.err(`MCP build artifact missing at ${absMcpPath} — run 'cd mcp && npm run build'`);
      } else if (tier === '1' && !serviceRoleForNode) {
        logImpl.err('no SUPABASE_SERVICE_ROLE_KEY available to write into Claude Desktop config');
      } else {
        const desktopEnv = tier === '0' ? {
          CONFIG_PATH: desktopConfig,
          MCP_SERVER_PATH: absMcpPath,
          DATABASE_URL: databaseUrlTier0,
          PLANNEN_TIER: '0',
          PLANNEN_USER_EMAIL: email,
        } : {
          CONFIG_PATH: desktopConfig,
          MCP_SERVER_PATH: absMcpPath,
          SUPABASE_URL: supabaseUrlForNode,
          SUPABASE_SERVICE_ROLE_KEY: serviceRoleForNode,
          PLANNEN_TIER: '1',
          PLANNEN_USER_EMAIL: email,
        };
        const r = await spawn(
          'node', [path.join(repoRoot, 'scripts/lib/claude-desktop-config.mjs')],
          { cwd: repoRoot, env: { ...process.env, ...composed, ...desktopEnv } },
        );
        if (r === 0) logImpl.ok('Claude Desktop config updated — restart Claude Desktop to pick it up');
        else logImpl.warn('Claude Desktop config update failed — see message above');
      }
    }
  } else {
    logImpl.dim('Claude Desktop not detected — skipping');
  }

  // ── 10b. Skills install ────────────────────────────────────────────────────
  logImpl.step('10b. Plannen skills for Claude Desktop / Claude.ai');
  let doSkills = false;
  if (nonInteractive) {
    if (installSkills) doSkills = true;
    else logImpl.dim('skipping skills install (--non-interactive without --install-skills)');
  } else {
    (ctx.writeRaw ?? ((s) => process.stdout.write(s)))(`  Plannen's plugin ships skills (intent gate, watch flow, story workflow…)
  that Claude Code loads from the plugin. Claude Desktop and Claude.ai don't
  see those — they read user skills from ~/.claude/skills. We can symlink
  Plannen's skills there so all surfaces share the same workflow logic.

  Skip this if you only use Claude Code with the plugin installed (which
  already loads them — installing twice would duplicate the entries).

`);
    const ans = await prompt('  Install Plannen skills under ~/.claude/skills? [Y/n]: ');
    const a = lower(ans);
    if (a === '' || a === 'y' || a === 'yes') doSkills = true;
    else logImpl.dim('skipped — install later with: bash scripts/skills-install.sh');
  }
  if (doSkills) {
    await spawn('bash', [path.join(repoRoot, 'scripts/skills-install.sh')], { cwd: repoRoot });
  }

  // ── Optional whisper setup ─────────────────────────────────────────────────
  await setupWhisper({
    nonInteractive, spawn: cspawn, sspawn, prompt, log: logImpl,
    write: ctx.writeRaw ?? ((s) => process.stdout.write(s)),
  });

  // ── 11. Final printout ─────────────────────────────────────────────────────
  logImpl.step('Done');
  finalPrintout({
    tier, email, databaseUrlTier0,
    repoRoot,
    write: ctx.writeRaw ?? ((s) => process.stdout.write(s)),
  });

  return 0;
}

// ── Tier 2 branch ────────────────────────────────────────────────────────────

async function runTier2({ rawArgs, ctx, env: penv }) {
  const { spawn, sspawn, prompt, mgmt, fetch: fetchImpl, log: logImpl, write } = ctx;
  const { repoRoot, envFile, exampleFile, email, tierChange } = penv;
  const { argProjectRef, argCloudDbUrl, forceOverwrite, acceptStorageQuota, skipPhotos, skipVercel, nonInteractive, startDev } = rawArgs;
  void skipPhotos; void acceptStorageQuota; void forceOverwrite; // forwarded as env vars below

  logImpl.step('4. Verifying supabase login');
  {
    const r = sspawn('supabase', ['projects', 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if ((r.status ?? 1) !== 0) {
      logImpl.err('supabase CLI is not logged in. Run: supabase login');
      return 1;
    }
  }
  logImpl.ok('supabase login active');

  logImpl.step('5. Resolving cloud project');
  let projectRef = argProjectRef;
  let pickedRegion = '';
  if (!projectRef) projectRef = envGet(envFile, 'SUPABASE_PROJECT_REF') ?? '';

  if (!projectRef && !nonInteractive) {
    const probe = sspawn('which', ['supabase']);
    if ((probe.status ?? 1) !== 0) {
      logImpl.err('supabase CLI not found — install with: brew install supabase/tap/supabase');
      return 1;
    }
    const verRes = sspawn('supabase', ['--version']);
    if ((verRes.status ?? 1) !== 0) {
      logImpl.err('supabase CLI is broken — try reinstalling');
      return 1;
    }
    const pickRes = sspawn('node', [path.join(repoRoot, 'scripts/lib/cloud-project-picker.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    if ((pickRes.status ?? 1) !== 0) {
      logImpl.err('project picker failed');
      return 1;
    }
    try {
      const picked = JSON.parse((pickRes.stdout ?? '').trim());
      projectRef = picked.ref;
      pickedRegion = picked.region;
      logImpl.dim(`  selected: ${projectRef} (${pickedRegion})`);
    } catch (e) {
      logImpl.err(`failed to parse project picker output: ${e.message}`);
      return 1;
    }
  }

  if (!projectRef) {
    if (nonInteractive) {
      logImpl.err('--mode=cloud_sb needs --project-ref or SUPABASE_PROJECT_REF in .env when --non-interactive');
      return 1;
    }
    logImpl.err('no project ref provided');
    return 1;
  }
  logImpl.ok(`project ref: ${projectRef}`);

  // Region auto-resolve via Management API if project ref came from .env.
  if (projectRef && !pickedRegion && !nonInteractive) {
    try {
      const token = mgmt.readAccessToken({});
      if (token) {
        const projects = await mgmt.listProjects(token, { fetch: fetchImpl });
        const p = projects.find((x) => x.ref === projectRef);
        if (p) {
          pickedRegion = p.region;
          logImpl.dim(`  region (auto-detected): ${pickedRegion}`);
        }
      }
    } catch {
      // Silent — fall through to URL prompt below if needed.
    }
  }

  let cloudDbUrl = argCloudDbUrl || (envGet(envFile, 'CLOUD_DATABASE_URL') ?? '');

  if (!cloudDbUrl && projectRef && pickedRegion && !nonInteractive) {
    logImpl.step("DB password (optional — only needed for `plannen backup` + tier 1→2 data restore)");
    logImpl.dim('  Supabase Dashboard → Project Settings → Database → Connection string → Pooler.');
    logImpl.dim('  Leave empty + press Enter to skip; set CLOUD_DATABASE_URL in your profile env later.');
    let pw = process.env.CLOUD_DB_PASSWORD ?? '';
    if (!pw) {
      pw = await prompt(`  postgres password for ${projectRef} (or empty to skip): `, { secret: true });
    }
    if (pw) {
      try {
        cloudDbUrl = buildPoolerUrl({ projectRef, region: pickedRegion, password: pw });
      } catch (e) {
        logImpl.err(`failed to build pooler URL: ${e.message}`);
        return 1;
      }
    } else {
      logImpl.dim('  skipped — CLOUD_DATABASE_URL not set; add it later if you want backups.');
    }
  }

  if (tierChange === '1->2' && !cloudDbUrl) {
    write(`\n  Cloud database URL is required for the data-restore step.\n  Format: postgresql://postgres.${projectRef}:<DB-PASSWORD>@<region>.pooler.supabase.com:6543/postgres\n  Find it in: Supabase Dashboard → Project Settings → Database → Connection string (Pooler).\n\n`);
    if (nonInteractive) {
      logImpl.err('--mode=cloud_sb 1->2 needs --cloud-db-url or CLOUD_DATABASE_URL in .env when --non-interactive');
      return 1;
    }
    cloudDbUrl = await prompt('  Cloud DATABASE_URL: ');
  }

  if (tierChange === '1->2') {
    logImpl.step('6. Ensuring local Tier 1 stack is up (source for migration)');
    const localStart = path.join(repoRoot, 'scripts/local-start.sh');
    if (existsSync(localStart)) {
      await spawn('bash', [localStart], { cwd: repoRoot });
    }
  } else {
    logImpl.step('6. Fresh Tier 2 (no prior Tier 1 data to migrate)');
    // Pre-mark every data-mutating step as already-done. None of them have
    // anything to do on a fresh install (no snapshot, no rows to restore, no
    // 127.0.0.1 URLs to rewrite, no photos to upload) — and rewrite-storage-urls
    // in particular needs CLOUD_DATABASE_URL, which we make optional for fresh
    // installs.
    const progressFile = path.join(repoRoot, '.plannen-tier2-progress');
    writeFileSync(
      progressFile,
      'snapshot\nrestore-data\nrewrite-storage-urls\nupload-photos\n',
      { encoding: 'utf8' },
    );
  }

  logImpl.step(
    tierChange === '1->2'
      ? '7. Running Tier 1 → Tier 2 migration orchestrator'
      : '7. Running Tier 2 setup orchestrator (link, schema, functions, deploy)',
  );
  let tier1SnapshotSql = '';
  if (tierChange === '1->2') {
    const snapDir = path.join(repoRoot, '.plannen', 'snapshots');
    mkdirSync(snapDir, { recursive: true });
    try {
      const files = readdirSync(snapDir).filter((f) => /^tier1-.*\.sql$/.test(f));
      const withMtimes = files.map((f) => ({ f, m: statSync(path.join(snapDir, f)).mtimeMs }));
      withMtimes.sort((a, b) => b.m - a.m);
      tier1SnapshotSql = withMtimes[0] ? path.join(snapDir, withMtimes[0].f) : '';
    } catch { /* no snapshots */ }
  }

  let tier1SrKey = envGet(exampleFile, 'SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const existingKey = envGet(envFile, 'SUPABASE_SERVICE_ROLE_KEY');
  if (existingKey) tier1SrKey = existingKey;

  {
    const migEnv = {
      ...process.env,
      SUPABASE_PROJECT_REF: projectRef,
      CLOUD_DATABASE_URL: cloudDbUrl,
      TIER1_SNAPSHOT_SQL: tier1SnapshotSql,
      DATABASE_URL_TIER1: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
      TIER1_STORAGE_URL: 'http://127.0.0.1:54321',
      TIER1_SERVICE_ROLE_KEY: tier1SrKey,
      PLANNEN_USER_EMAIL: email,
      GOOGLE_CLIENT_ID: envGet(envFile, 'GOOGLE_CLIENT_ID') ?? '',
      GOOGLE_CLIENT_SECRET: envGet(envFile, 'GOOGLE_CLIENT_SECRET') ?? '',
      FORCE_OVERWRITE: forceOverwrite ? '1' : '0',
      ACCEPT_STORAGE_QUOTA: acceptStorageQuota ? '1' : '0',
      ...(skipPhotos ? { SKIP_PHOTOS: '1' } : {}),
    };
    const c = await spawn(
      'node', [path.join(repoRoot, 'scripts/lib/migrate-tier1-to-tier2.mjs')],
      { cwd: repoRoot, env: migEnv },
    );
    if (c !== 0) {
      logImpl.err(
        tierChange === '1->2'
          ? `tier 1→2 migration failed (exit ${c})`
          : `tier 2 setup failed (exit ${c})`,
      );
      return c;
    }
  }
  logImpl.ok('Tier 2 deployed');

  if (!nonInteractive && !skipVercel) {
    logImpl.step('Deploy web app to Vercel?');
    const ans = (await prompt('  [Y/n] ')).trim();
    if (/^(n|no)$/i.test(ans)) {
      logImpl.dim('  skipped — run `npx plannen deploy` later');
    } else {
      const probe = sspawn('which', ['vercel']);
      if ((probe.status ?? 1) !== 0) {
        logImpl.err('  vercel CLI not found — install with: npm i -g vercel');
        logImpl.dim('  then run: npx plannen deploy');
      } else {
        const who = sspawn('vercel', ['whoami']);
        if ((who.status ?? 1) !== 0) {
          logImpl.err('  vercel CLI not logged in — run: vercel login');
          logImpl.dim('  then run: npx plannen deploy');
        } else {
          await spawn('npx', ['plannen', 'deploy'], { cwd: repoRoot });
        }
      }
    }
  }

  logImpl.step('8. Cloud doctor');
  {
    const docEnv = {
      ...process.env,
      SUPABASE_URL: envGet(envFile, 'SUPABASE_URL') ?? '',
      SUPABASE_ANON_KEY: envGet(envFile, 'SUPABASE_ANON_KEY') ?? '',
      SUPABASE_PROJECT_REF: projectRef,
      MCP_BEARER_TOKEN: envGet(envFile, 'MCP_BEARER_TOKEN') ?? '',
      PLANNEN_USER_EMAIL: email,
      CLOUD_DATABASE_URL: cloudDbUrl,
      // Tell the doctor about the freshly-deployed Vercel URL so its site_url
      // check accepts the production URL set by Vercel-deploy's post-deploy
      // wire-auth (not just the hardcoded local default).
      PLANNEN_WEB_URL: envGet(envFile, 'PLANNEN_WEB_URL') ?? '',
    };
    const c = await spawn(
      'node', [path.join(repoRoot, 'scripts/cloud-doctor.mjs')],
      { cwd: repoRoot, env: docEnv },
    );
    if (c !== 0) logImpl.warn('cloud-doctor reported issues — review above');
  }

  // ── 8b. Dev server (Tier 2) ────────────────────────────────────────────────
  // Mirrors the Tier 0/1 step 8b — the cloud project is reachable, but the
  // local web app at :4321 still has to come up if the user wants to develop
  // against it. (The Vercel deploy already gave them a production URL.)
  logImpl.step('8b. Web app dev server (npm run dev)');
  {
    let doDev = false;
    if (nonInteractive) {
      if (startDev) doDev = true;
      else logImpl.dim('skipping dev server (--non-interactive without --start-dev)');
    } else {
      const ans = await prompt('  Start npm run dev locally now? [Y/n]: ');
      const a = lower(ans);
      if (a === '' || a === 'y' || a === 'yes') doDev = true;
      else logImpl.dim('skipped — start later with: bash scripts/dev-start.sh');
    }
    if (doDev) {
      const c = await spawn('bash', [path.join(repoRoot, 'scripts/dev-start.sh')], { cwd: repoRoot, env: { ...process.env, ...composed } });
      if (c !== 0) logImpl.warn(`dev-start returned ${c}`);
    }
  }

  logImpl.step('9. Next steps');
  const supabaseUrlT2 = envGet(envFile, 'SUPABASE_URL') ?? '';
  const c = colorPalette();
  // The rollback hint only makes sense if we actually backed up Tier 1 state
  // during a 1→2 upgrade. For a fresh cloud_sb install there's no .bak to
  // restore, so the line would mislead the user.
  const rollbackHint = tierChange === '1->2'
    ? `\n  Rollback to Tier 1: \`plannen init --mode=local_sb\` will restore\n    .env.tier1.bak and plugin.json.tier1.bak. Your cloud project is left\n    untouched.\n`
    : '';
  write(`\n  ${c.green}✓${c.reset} Plannen (Tier 2) is deployed for ${c.cyan}${email}${c.reset}.\n\n  Cloud project: ${projectRef}\n  Cloud URL:     ${supabaseUrlT2}\n\n  Next steps:\n    1. Reload the plannen plugin in Claude Code so it picks up the new\n       HTTP MCP endpoint. (In Claude Code: /plugin reload, or restart.)\n    2. Add the Google OAuth callback URL to your Google Cloud OAuth client:\n         ${supabaseUrlT2}/functions/v1/google-oauth-callback\n    3. Web app: \`npm run dev\` now talks to your cloud project.\n    4. Rotate the MCP bearer any time with:\n         npx plannen token rotate\n${rollbackHint}\n`);
  return 0;
}

// ── Whisper setup ─────────────────────────────────────────────────────────────

async function setupWhisper({ nonInteractive, spawn, sspawn, prompt, log, write }) {
  log.step('Optional: whisper.cpp for audio transcription');
  const home = os.homedir();
  const whisperDir = path.join(home, '.plannen', 'whisper');
  const whisperFile = path.join(whisperDir, 'ggml-base.en.bin');
  const whisperUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

  const have = sspawn('which', ['whisper-cli']);
  if ((have.status ?? 1) === 0) {
    const which = sspawn('which', ['whisper-cli']);
    write(`  whisper-cli already installed at ${(which.stdout ?? '').trim()}\n`);
  } else {
    write(`  Audio memories can be transcribed locally with whisper.cpp. This is OPTIONAL —
  audio uploads + plays without it; the story flow just won't see audio content.

    macOS:  brew install whisper-cpp
    Linux:  build from https://github.com/ggerganov/whisper.cpp

`);
    const isDarwin = process.platform === 'darwin';
    const haveBrew = isDarwin && (sspawn('which', ['brew']).status ?? 1) === 0;
    if (haveBrew && !nonInteractive) {
      const ans = await prompt('  Install via brew now? [y/N] ');
      if (/^[Yy]/.test(ans)) {
        const c = await spawn('brew', ['install', 'whisper-cpp']);
        if (c !== 0) log.dim('  brew install failed — install manually if you want this');
      } else {
        log.dim("  Skipped. You can run 'brew install whisper-cpp' later.");
      }
    } else {
      log.dim('  No brew detected — install manually if you want this.');
    }
  }

  // Recheck whisper presence (may have just been installed).
  const have2 = sspawn('which', ['whisper-cli']);
  if ((have2.status ?? 1) === 0) {
    if (existsSync(whisperFile)) {
      write(`  Model present at ${whisperFile}\n`);
    } else if (!nonInteractive) {
      const ans = await prompt(`  Download default model (ggml-base.en.bin, ~150 MB) to ${whisperFile}? [y/N] `);
      if (/^[Yy]/.test(ans)) {
        mkdirSync(whisperDir, { recursive: true });
        const curl = sspawn('which', ['curl']);
        if ((curl.status ?? 1) === 0) {
          const c = await spawn('curl', ['-L', '--fail', '-o', whisperFile, whisperUrl]);
          if (c !== 0) log.dim(`  Download failed — fetch manually from ${whisperUrl}`);
        } else {
          log.dim('  curl missing — install curl or fetch manually');
        }
      } else {
        log.dim(`  Skipped. Download manually from ${whisperUrl}`);
        log.dim(`  and place it at ${whisperFile} (or set PLANNEN_WHISPER_MODEL).`);
      }
    }

    // ffmpeg — required for browser voice notes (opus/webm).
    const ffprobe = sspawn('which', ['ffmpeg']);
    if ((ffprobe.status ?? 1) === 0) {
      const which = sspawn('which', ['ffmpeg']);
      write(`  ffmpeg present at ${(which.stdout ?? '').trim()}\n`);
    } else {
      write(`
  ffmpeg is recommended alongside whisper-cli. Browser voice notes are
  recorded as Opus, which whisper-cli can't decode on its own — ffmpeg
  converts them to WAV first.

`);
      const isDarwin = process.platform === 'darwin';
      const haveBrew = isDarwin && (sspawn('which', ['brew']).status ?? 1) === 0;
      if (haveBrew && !nonInteractive) {
        const ans = await prompt('  Install ffmpeg via brew now? [y/N] ');
        if (/^[Yy]/.test(ans)) {
          const c = await spawn('brew', ['install', 'ffmpeg']);
          if (c !== 0) log.dim('  brew install failed — install manually if you want this');
        } else {
          log.dim("  Skipped. You can run 'brew install ffmpeg' later.");
        }
      } else {
        log.dim('  No brew detected — install ffmpeg manually if you want voice-note transcription.');
      }
    }
  }
}

// ── Final printout ────────────────────────────────────────────────────────────

function finalPrintout({ tier, email, databaseUrlTier0, repoRoot, write }) {
  const c = colorPalette();
  const devPidPath = path.join(repoRoot, '.plannen', 'dev.pid');
  const devRunning = pidAlive(devPidPath);
  const devPid = devRunning ? readFileSync(devPidPath, 'utf8').trim() : '';

  const webLine = devRunning
    ? `running (PID ${devPid}) → http://localhost:4321\n              Logs:      .plannen/dev.log\n              Stop:      npx plannen down`
    : 'npx plannen up   →  http://localhost:4321';

  if (tier === '0') {
    write(`\n  ${c.green}✓${c.reset} Plannen (Tier 0) is configured for ${c.cyan}${email}${c.reset}.\n\n  Storage:    embedded Postgres at ${databaseUrlTier0}\n              Data dir:  ~/.plannen/pgdata\n              Stop:      npx plannen down\n\n  Backend:    running on http://127.0.0.1:54323\n              Logs:      ~/.plannen/backend.log\n              Stop:      npx plannen down\n\n  Web app:    ${webLine}\n\n  MCP path:   Claude Code / Claude Desktop talk to your local data via the\n              plannen MCP server in mcp/dist/index.js.\n\n`);
  } else {
    const functionsPidPath = path.join(repoRoot, '.plannen', 'functions.pid');
    const fnPid = pidAlive(functionsPidPath)
      ? readFileSync(functionsPidPath, 'utf8').trim()
      : '?';
    write(`\n  ${c.green}✓${c.reset} Plannen (Tier 1) is configured for ${c.cyan}${email}${c.reset}.\n\n  Next steps:\n    → Web app:    ${webLine}\n    → Sign in:    enter ${email}, click "Magic link"\n                  Link arrives at http://127.0.0.1:54324 (Mailpit)\n    → AI key:     optional — only needed for AI features in the web app\n                  (discovery, stories, image extraction).\n                  web app → /settings → paste your Anthropic key\n                  Skip if you only use Plannen via Claude Code / Desktop.\n    → Functions:  running in background (PID ${fnPid})\n                  Logs:  .plannen/functions.log\n                  Stop:  npx plannen down\n\n`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function confirmEmail(defaultEmail, prompt, log) {
  let current = defaultEmail;
  for (;;) {
    let ans;
    if (current) {
      const c = colorPalette();
      ans = await prompt(`  Use ${c.cyan}${current}${c.reset} as your Plannen user? [Y/n/edit]: `);
    } else {
      ans = await prompt('  Enter the email to use as your Plannen user: ');
    }
    const a = lower(ans);
    if (current && (a === '' || a === 'y' || a === 'yes')) return current;
    if (current && (a === 'n' || a === 'no')) {
      log.err('Cancelled by user');
      throw new Error('email cancelled');
    }
    // edit or any other input — treat as new value (when given) or re-prompt.
    if (current && (a === 'e' || a === 'edit')) {
      const v = await prompt('  Enter the email to use: ');
      if (v) current = v;
      continue;
    }
    if (ans.trim()) current = ans.trim();
  }
}

// Default background spawner — used for plannen-pg.mjs init, mirrors the bash
// `nohup … >> log 2>&1 & disown` idiom.
function defaultSpawnBg(cmd, args, { cwd, logPath, env } = {}) {
  const out = openSync(logPath ?? '/dev/null', 'a');
  const child = nodeSpawn(cmd, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return { pid: child.pid };
}

// readUserCount + insertAuthUser shell to a tiny inline pg client probe. Bash
// did the same thing — the only reason it's a subprocess (not pg.Pool here) is
// to keep this orchestrator from declaring a pg dependency.
async function readUserCount(databaseUrl, sspawn, repoRoot) {
  const r = sspawn(
    'node',
    ['-e', `const pg=require("pg");(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query("SELECT count(*) FROM plannen.users");process.stdout.write(r.rows[0].count);await c.end();})();`],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' },
  );
  if ((r.status ?? 1) !== 0) return 0;
  return Number((r.stdout ?? '').trim() || 0);
}

async function insertAuthUser(databaseUrl, email, sspawn, repoRoot) {
  const r = sspawn(
    'node',
    ['-e', `const pg = require("pg");const c = new pg.Client({ connectionString: process.env.DATABASE_URL });const email = process.env.EMAIL;c.connect().then(() => c.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id", [email])).then(r => { process.stdout.write(r.rows[0].id); return c.end() }).catch(e => { process.stderr.write(e.message + "\\n"); process.exit(1) })`],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl, EMAIL: email }, encoding: 'utf8' },
  );
  if ((r.status ?? 1) !== 0) return '';
  return (r.stdout ?? '').trim();
}

function makeLog(overrides = {}) {
  return {
    step: overrides.step ?? step,
    ok: overrides.ok ?? ok,
    warn: overrides.warn ?? warn,
    err: overrides.err ?? err,
    dim: overrides.dim ?? dim,
  };
}
