import { defineCommand } from 'citty';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeEnv,
  getProfileEnvPath,
  profileExists,
  resolveActiveProfile,
} from '../lib/profiles.mjs';
import {
  run as vercelRun,
  upsertEnvKey,
} from '../../scripts/lib/vercel-deploy.mjs';
import { listAppliedMigrations } from '../../scripts/lib/supabase-mgmt.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * Native-JS deploy. Replaces the old scripts/vercel-deploy.sh wrapper. The
 * heavy lifting (env push, vercel deploy, stable-alias resolution, Supabase
 * Auth wiring) already lives in scripts/lib/vercel-deploy.mjs — this verb
 * adds profile resolution, mode validation, pre-flight, and auto-link.
 *
 * All side effects are dep-injectable via ctx so tests can pass a fake CLI
 * (no `vercel` binary on the test machine needed).
 */
export async function invokeDeploy(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  // vercel-deploy.mjs splits stdin-bearing calls (env add) from plain calls.
  // Both default to real `vercel` binary execution. Tests can supply either or
  // both — when only `cli` is given we reuse it for stdin calls too.
  const cli = ctx.cli;
  const cliWithStdin = ctx.cliWithStdin ?? ctx.cli;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const readFile = ctx.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const writeFile = ctx.writeFile ?? ((p, t) => writeFileSync(p, t));
  const exists = ctx.exists ?? existsSync;
  const ensureBin = ctx.ensureBin ?? defaultEnsureBin;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  if (!profileName) {
    throw new Error('deploy: no active profile. Pass --profile=<name> or run `plannen init --mode=cloud_sb` first.');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`deploy: profile '${profileName}' does not exist`);
  }

  // Authoritative mode signal is the composed env's PLANNEN_TIER, not the
  // manifest's `mode`. The manifest is set at profile-create time; bootstrap's
  // tier transitions update the env file (and the symlinked .env) but don't
  // rewrite the manifest, so a long-lived profile can have a stale `mode`
  // while the env reflects the real current tier.
  const composed = composeEnv(profileName, {}, baseEnv);
  if (composed.PLANNEN_TIER !== '2') {
    throw new Error(
      `deploy: profile '${profileName}' has PLANNEN_TIER=${composed.PLANNEN_TIER ?? '(unset)'}; ` +
      `vercel deploy is cloud_sb (tier 2) only`,
    );
  }

  ensureBin('vercel');
  // Prefer `<repo>/.env` (which is normally a symlink to the profile env, so
  // both reads are equivalent). When a worktree was created without running
  // `plannen init` — e.g. a code-review checkout — `.env` won't exist; fall
  // back to the profile env file directly so deploy still works.
  const repoEnvPath = path.join(repoRoot, '.env');
  const envPath = exists(repoEnvPath) ? repoEnvPath : getProfileEnvPath(profileName, baseEnv);
  const envText = readFile(envPath);
  if (envPath !== repoEnvPath) {
    log(`==> Using profile env (${envPath}) — no .env in this worktree.`);
  }

  // Never auto-link with `--yes`. Vercel's --yes accepts ALL prompts including
  // the project-name prompt, which defaults to the current dir's basename. From
  // a worktree like `.worktrees/foo` it silently creates a NEW Vercel project
  // called `foo`, separate from the user's intended project. Issue #24.
  if (!exists(path.join(repoRoot, '.vercel'))) {
    if (rawArgs['vercel-project']) {
      log(`==> No .vercel/ found — running \`vercel link --yes --project ${rawArgs['vercel-project']}\``);
      // Drive the link call ourselves rather than via vercelLink helper (which
      // is fixed to --yes-only). Use the dep-injected cli.
      const linker = ctx.cli ?? ((args) => spawnSync('vercel', args, { encoding: 'utf8' }));
      const r = linker(['link', '--yes', '--project', rawArgs['vercel-project']]);
      if (r.status !== 0) {
        throw new Error(`vercel link → exit ${r.status}: ${r.stderr || r.stdout}`);
      }
    } else {
      throw new Error(
        'deploy: no .vercel/ found in this worktree.\n' +
        '  Either:\n' +
        '    a) cd to a worktree that already has .vercel/ linked, OR\n' +
        '    b) run `vercel link` interactively here first, OR\n' +
        '    c) re-run with --vercel-project=<existing-project-name>.\n' +
        '  Refusing to auto-link because `vercel link --yes` would create a NEW\n' +
        '  project named after this directory (' + path.basename(repoRoot) + '), not your intended one.',
      );
    }
  }

  await warnPendingMigrations({
    composed,
    repoRoot,
    fetch: ctx.fetch ?? globalThis.fetch,
    log,
  });

  log(`==> Deploying profile '${profileName}' to Vercel (${rawArgs.target ?? 'production'})`);
  const result = await vercelRun(
    {
      envText,
      target: rawArgs.target ?? 'production',
      prod: rawArgs.prod !== false,
    },
    { cli, cliWithStdin, log: (s) => log(s) },
  );

  if (result.primaryUrl) {
    const updated = upsertEnvKey(envText, 'PLANNEN_WEB_URL', result.primaryUrl);
    writeFile(envPath, updated);
    log(`==> Wrote PLANNEN_WEB_URL=${result.primaryUrl} to ${envPath}`);
  }
  log(`==> Deployment URL: ${result.deploymentUrl ?? '(not parsed — check stdout above)'}`);
  log(`==> Pushed ${result.pushedKeys.length} env var(s)`);

  return { ...result, profile: profileName };
}

/**
 * Compare local supabase/migrations versions against the remote project's
 * applied set; log a non-blocking warning naming any that are pending.
 *
 * Silently skips when the profile lacks Supabase Management API creds, the
 * supabase/migrations directory is missing, or the API call fails — we never
 * want this guardrail to block a deploy on missing optional creds or network
 * flakes. The deploy itself remains the authoritative success/fail signal.
 */
async function warnPendingMigrations({ composed, repoRoot, fetch, log }) {
  const token = composed.SUPABASE_ACCESS_TOKEN;
  const ref = composed.SUPABASE_PROJECT_REF;
  if (!token || !ref) return;

  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  if (!existsSync(migrationsDir)) return;

  let localVersions;
  try {
    localVersions = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
  } catch {
    return;
  }
  if (localVersions.length === 0) return;

  let applied;
  try {
    applied = await listAppliedMigrations(token, ref, { fetch });
  } catch (e) {
    log(`==> WARNING: could not check remote migration state (${e.message}); proceeding anyway`);
    return;
  }
  const appliedSet = new Set(applied);
  const pending = localVersions.filter((v) => !appliedSet.has(v));
  if (pending.length === 0) return;

  log(`==> WARNING: ${pending.length} pending migration(s) on the remote Supabase project`);
  log('    Deploy will proceed, but the frontend will run against the OLD schema until you run:');
  log('      npx plannen migrate');
  for (const v of pending) log(`      - ${v}`);
}

function defaultEnsureBin(bin) {
  const r = spawnSync('which', [bin]);
  if (r.status !== 0) {
    throw new Error(`${bin} CLI not found on PATH. Install with: npm i -g ${bin}`);
  }
}

export const deployCommand = defineCommand({
  meta: {
    name: 'deploy',
    description: 'Deploy the web app to Vercel for the active cloud_sb profile',
  },
  args: {
    profile: { type: 'string', description: 'Profile to deploy (defaults to the active profile)' },
    target: { type: 'string', description: 'Vercel env target: production | preview | development (default production)' },
    'vercel-project': { type: 'string', description: 'Vercel project name to link if .vercel/ is missing (refuses to auto-link otherwise — see issue #24)' },
  },
  async run({ args }) {
    await invokeDeploy(args);
    process.exit(0);
  },
});
