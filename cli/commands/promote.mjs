import { defineCommand } from 'citty';
import { spawnSync } from 'node:child_process';

import {
  composeEnv,
  isSyntheticMode,
  profileExists,
} from '../lib/profiles.mjs';
import * as supabaseMgmt from '../../scripts/lib/supabase-mgmt.mjs';
import * as cloudDeploy from '../../scripts/lib/cloud-deploy.mjs';

/**
 * Keys we expect on a cloud_sb profile. In synthetic mode (CI), the workflow
 * supplies these prefixed: `STAGING_<KEY>` and `PROD_<KEY>`. Promote strips
 * the prefix and exposes them under the bare names listed here.
 */
const CLOUD_PROFILE_KEYS = [
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_PASSWORD',
  'DATABASE_URL',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_ORG_ID',
  'PLANNEN_USER_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
];

/**
 * Load a named cloud profile's env. Two code paths share one shape:
 *   - synthetic (CI): `<SIDE>_<KEY>` env vars → bare keys.
 *   - on-disk: composeEnv reads ~/.plannen/profiles/<name>/env.
 */
export function loadCloudProfile(side, baseEnv) {
  if (isSyntheticMode(baseEnv)) {
    const prefix = side.toUpperCase() + '_';
    const out = { PLANNEN_PROFILE: side };
    for (const k of CLOUD_PROFILE_KEYS) {
      const v = baseEnv[prefix + k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (!profileExists(side, baseEnv)) {
    throw new Error(`promote: profile '${side}' does not exist (run \`plannen profile create ${side} --mode=cloud_sb\` first)`);
  }
  return composeEnv(side, {}, baseEnv);
}

function defaultSupabaseCli(args, opts = {}) {
  const r = spawnSync('supabase', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function defaultVercelCli(args, opts = {}) {
  const r = spawnSync('vercel', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function defaultEnsureBin(bin) {
  const r = spawnSync('which', [bin]);
  if (r.status !== 0) {
    throw new Error(`${bin} CLI not found on PATH. Install with: npm i -g ${bin}`);
  }
}

// Vercel prints the deployment URL as the first https:// line on stdout.
export function parseVercelUrl(stdout) {
  const m = (stdout ?? '').match(/https:\/\/[a-z0-9.\-]+\.vercel\.app/i);
  return m ? m[0] : null;
}

/**
 * `plannen promote` — replay staging's schema/functions/build against prod.
 * Spec: docs/superpowers/specs/2026-05-17-plannen-cli-and-cicd-design.md §5
 *
 * Steps:
 *   1. Migration parity check (Management API SQL against both projects).
 *   2. `supabase link --project-ref <prod>` + `supabase db push --linked`.
 *   3. Deploy edge functions to prod via cloud-deploy.run().
 *   4. `vercel --prod` against the prod project.
 */
export async function invokePromote(rawArgs = {}, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const fetch = ctx.fetch ?? globalThis.fetch;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const ensureBin = ctx.ensureBin ?? defaultEnsureBin;
  const supabaseCli = ctx.supabaseCli ?? defaultSupabaseCli;
  const vercelCli = ctx.vercelCli ?? defaultVercelCli;
  const cloudDeployRun = ctx.cloudDeployRun ?? cloudDeploy.run;

  const stagingName = rawArgs['staging-profile'] ?? 'staging';
  const prodName = rawArgs['prod-profile'] ?? 'prod';

  const staging = loadCloudProfile(stagingName, baseEnv);
  const prod = loadCloudProfile(prodName, baseEnv);

  for (const [side, env] of [[stagingName, staging], [prodName, prod]]) {
    for (const k of ['SUPABASE_PROJECT_REF', 'SUPABASE_ACCESS_TOKEN']) {
      if (!env[k]) throw new Error(`promote: ${side} profile missing ${k}`);
    }
  }
  for (const k of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
    if (!prod[k]) throw new Error(`promote: prod profile missing ${k} (required for non-interactive vercel deploy)`);
  }

  // ── 1. Parity check ─────────────────────────────────────────────────
  log(`==> Parity check: ${stagingName} vs ${prodName} migrations`);
  const stagingApplied = await supabaseMgmt.listAppliedMigrations(
    staging.SUPABASE_ACCESS_TOKEN, staging.SUPABASE_PROJECT_REF, { fetch },
  );
  const prodApplied = await supabaseMgmt.listAppliedMigrations(
    prod.SUPABASE_ACCESS_TOKEN, prod.SUPABASE_PROJECT_REF, { fetch },
  );
  const prodAhead = prodApplied.filter((v) => !stagingApplied.includes(v));
  if (prodAhead.length > 0) {
    throw new Error(
      `promote: prod is ahead of staging by ${prodAhead.length} migration(s):\n  ` +
      prodAhead.join('\n  ') +
      `\nRefusing to promote — drift means something was hand-applied to prod. Investigate first.`,
    );
  }
  const willApply = stagingApplied.filter((v) => !prodApplied.includes(v));
  if (willApply.length > 0) {
    log(`==> ${willApply.length} migration(s) will apply to prod:`);
    for (const v of willApply) log(`     - ${v}`);
  } else {
    log('==> Migrations identical between staging and prod');
  }

  // ── 2. Link prod + db push ─────────────────────────────────────────
  ensureBin('supabase');
  ensureBin('vercel');

  const supabaseEnv = {
    ...baseEnv,
    SUPABASE_ACCESS_TOKEN: prod.SUPABASE_ACCESS_TOKEN,
    SUPABASE_DB_PASSWORD: prod.SUPABASE_DB_PASSWORD ?? baseEnv.SUPABASE_DB_PASSWORD ?? '',
  };
  log(`==> Linking supabase CLI to prod (${prod.SUPABASE_PROJECT_REF})`);
  const linkRes = supabaseCli(['link', '--project-ref', prod.SUPABASE_PROJECT_REF], { env: supabaseEnv });
  if (linkRes.status !== 0) {
    throw new Error(`supabase link → exit ${linkRes.status}: ${linkRes.stderr || linkRes.stdout}`);
  }
  log('==> supabase db push --linked');
  const pushRes = supabaseCli(['db', 'push', '--linked'], { env: supabaseEnv });
  if (pushRes.status !== 0) {
    throw new Error(`supabase db push → exit ${pushRes.status}: ${pushRes.stderr || pushRes.stdout}`);
  }

  // ── 3. Edge functions ──────────────────────────────────────────────
  log('==> Deploying edge functions to prod');
  await cloudDeployRun(
    {
      projectRef: prod.SUPABASE_PROJECT_REF,
      userEmail: prod.PLANNEN_USER_EMAIL,
      googleClientId: prod.GOOGLE_CLIENT_ID,
      googleClientSecret: prod.GOOGLE_CLIENT_SECRET,
      anthropicApiKey: prod.ANTHROPIC_API_KEY,
      extraSecrets: {
        ...(prod.VAPID_PUBLIC_KEY ? { VAPID_PUBLIC_KEY: prod.VAPID_PUBLIC_KEY } : {}),
        ...(prod.VAPID_PRIVATE_KEY ? { VAPID_PRIVATE_KEY: prod.VAPID_PRIVATE_KEY } : {}),
        ...(prod.VAPID_SUBJECT ? { VAPID_SUBJECT: prod.VAPID_SUBJECT } : {}),
        ...(prod.LLM_API_KEY ? { LLM_API_KEY: prod.LLM_API_KEY } : {}),
        ...(prod.LLM_BASE_URL ? { LLM_BASE_URL: prod.LLM_BASE_URL } : {}),
        ...(prod.LLM_MODEL ? { LLM_MODEL: prod.LLM_MODEL } : {}),
      },
    },
    { cli: (args, opts = {}) => supabaseCli(args, { ...opts, env: supabaseEnv }) },
  );

  // ── 4. Vercel prod build ───────────────────────────────────────────
  log(`==> vercel --prod against project ${prod.VERCEL_PROJECT_ID}`);
  const vercelEnv = {
    ...baseEnv,
    VERCEL_TOKEN: prod.VERCEL_TOKEN,
    VERCEL_ORG_ID: prod.VERCEL_ORG_ID,
    VERCEL_PROJECT_ID: prod.VERCEL_PROJECT_ID,
  };
  const deployRes = vercelCli(
    ['--prod', '--yes', '--token', prod.VERCEL_TOKEN],
    { env: vercelEnv },
  );
  if (deployRes.status !== 0) {
    throw new Error(`vercel --prod → exit ${deployRes.status}: ${deployRes.stderr || deployRes.stdout}`);
  }
  const deploymentUrl = parseVercelUrl(deployRes.stdout);
  log(`==> Prod deployment: ${deploymentUrl ?? '(URL not parsed — see vercel stdout above)'}`);

  return {
    staging: stagingName,
    prod: prodName,
    stagingApplied,
    prodApplied,
    appliedToProd: willApply,
    deploymentUrl,
  };
}

export const promoteCommand = defineCommand({
  meta: {
    name: 'promote',
    description: 'Replay staging\'s schema, functions, and Vercel build against prod (staging → prod)',
  },
  args: {
    'staging-profile': { type: 'string', description: 'Source profile name (default: staging)' },
    'prod-profile': { type: 'string', description: 'Target profile name (default: prod)' },
    'non-interactive': { type: 'boolean', description: 'Reserved for CI parity; promote is already non-interactive' },
  },
  async run({ args }) {
    await invokePromote(args);
    process.exit(0);
  },
});
