import { defineCommand } from 'citty';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeEnv,
  getProfileEnvPath,
  profileExists,
  readManifest,
  resolveActiveProfile,
  writeEnvFile,
  readEnvFile,
} from '../../lib/profiles.mjs';
import os from 'node:os';
import pg from 'pg';
import * as cloudLink from '../../../scripts/lib/cloud-link.mjs';
import * as cloudDeploy from '../../../scripts/lib/cloud-deploy.mjs';
import { buildPoolerUrl } from '../../../scripts/lib/cloud-db-url.mjs';
import * as supabaseMgmt from '../../../scripts/lib/supabase-mgmt.mjs';
import { invokePasskeysEnable, deriveRpId, deriveOrigins } from './passkeys.mjs';
import { CONSENT_PATH } from './oauth.mjs';
import { run as vercelRun, vercelLink, upsertEnvKey } from '../../../scripts/lib/vercel-deploy.mjs';
import { mintToken } from '../../../scripts/lib/userTokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

/**
 * Step list for `plannen cloud provision`. Order matters for resume; each step
 * appends its name to `.plannen-provision-<profile>-progress` when it succeeds
 * and is skipped on re-run.
 */
export const STEPS = [
  'preflight',
  'prompt-supabase',     // user creates project in dashboard, gives us ref + db pw
  'link-supabase',       // supabase link --project-ref + fetch anon/service keys
  'push-schema',         // supabase db push --linked
  'deploy-functions',    // edge functions + secrets
  'prompt-vercel',       // user creates Vercel project in dashboard, gives us name
  'link-vercel',         // vercel link --yes --project <name>
  'push-env-vercel',     // VITE_* + PLANNEN_* into Vercel env (production target)
  'first-deploy',        // vercel --prod, capture URL
  'wire-auth',           // Site URL + redirect allow-list via Management API
  'enable-passkeys',     // WebAuthn RP ID + origins + passkey_enabled via Management API
  'enable-oauth',        // OAuth 2.1 server + DCR + consent path via Management API (claude.ai connectors)
];

export function readProgress(progressPath) {
  if (!existsSync(progressPath)) return new Set();
  return new Set(
    readFileSync(progressPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

export function markProgress(progressPath, step) {
  appendFileSync(progressPath, `${step}\n`);
}

export function pendingSteps(allSteps, done) {
  return allSteps.filter((s) => !done.has(s));
}

export function progressPathFor(repoRoot, profileName) {
  return path.join(repoRoot, `.plannen-provision-${profileName}-progress`);
}

/**
 * Default interactive prompt — reads one line from stdin. Tests pass an own
 * `prompt(question)` impl via ctx.
 */
async function defaultPrompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function defaultEnsureBin(bin) {
  const r = spawnSync('which', [bin]);
  if (r.status !== 0) {
    throw new Error(`${bin} CLI not found on PATH`);
  }
}

/**
 * Read profile env file, run f({ env, write }) and persist the merged result.
 * Atomic from the caller's POV — read-modify-write each step that touches env.
 */
function withProfileEnv(profileName, baseEnv, repoRoot, mutator) {
  const envPath = getProfileEnvPath(profileName, baseEnv);
  const current = readEnvFile(envPath);
  const next = { ...current, ...mutator(current) };
  writeEnvFile(envPath, next);
  // Mirror to <repo>/.env if it's a regular file (rare in PR2+ where it's a
  // symlink — symlink writes flow through transparently).
  const repoEnv = path.join(repoRoot, '.env');
  if (existsSync(repoEnv)) {
    // No-op for symlinks (writeFile on the link target == writeFile on profile env)
    // For regular files, sync the values.
    try {
      const repoText = readFileSync(repoEnv, 'utf8');
      let updated = repoText;
      for (const [k, v] of Object.entries(next)) {
        updated = upsertEnvKey(updated, k, v);
      }
      if (updated !== repoText) writeFileSync(repoEnv, updated);
    } catch {/* missing or unwritable — fine */}
  }
}

export async function invokeProvision(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const prompt = ctx.prompt ?? defaultPrompt;
  const ensureBin = ctx.ensureBin ?? defaultEnsureBin;
  const cli = ctx.cli;
  const cliWithStdin = ctx.cliWithStdin ?? ctx.cli;
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;
  const linkRun = ctx.cloudLinkRun ?? cloudLink.run;
  const deployRun = ctx.cloudDeployRun ?? cloudDeploy.run;
  const mintTokenFn = ctx.mintTokenFn ?? null; // null → real mintToken used in deployFunctions
  const vercelDeployRun = ctx.vercelRun ?? vercelRun;
  const link = ctx.vercelLink ?? vercelLink;

  // ── PR3b inputs ───────────────────────────────────────────────────────────
  const profileName = rawArgs.profile;
  if (!profileName) {
    throw new Error('cloud provision: --profile <name> is required');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(
      `cloud provision: profile '${profileName}' does not exist. ` +
      `Run \`plannen profile create ${profileName} --mode=cloud_sb\` first.`,
    );
  }
  const manifest = readManifest(profileName, baseEnv);
  if (manifest.mode !== 'cloud_sb') {
    throw new Error(`cloud provision: profile '${profileName}' has mode=${manifest.mode}; cloud_sb required`);
  }

  ensureBin('supabase');
  ensureBin('vercel');

  const progressPath = progressPathFor(repoRoot, profileName);
  const done = readProgress(progressPath);
  const pending = pendingSteps(STEPS, done);
  if (pending.length === 0) {
    log(`  all steps already complete (delete ${progressPath} to re-run)`);
    return { skipped: true };
  }

  log(`==> provisioning '${profileName}' (${pending.length}/${STEPS.length} steps pending)`);

  // Carry context across steps — keys from prompts/links/etc. accumulate here.
  let cur = {
    profileName,
    repoRoot,
    ...composeEnv(profileName, {}, baseEnv),
  };

  for (const step of pending) {
    log(`▸ step: ${step}`);
    switch (step) {
      case 'preflight':
        runPreflight({ cli, mgmt, log });
        break;
      case 'prompt-supabase':
        cur = { ...cur, ...(await promptSupabase({ prompt, log })) };
        break;
      case 'link-supabase':
        cur = await linkSupabase(cur, { cli, linkRun, log, baseEnv, repoRoot });
        break;
      case 'push-schema':
        pushSchema(cur, { cli, log });
        break;
      case 'deploy-functions':
        cur = await deployFunctions(cur, { cli, deployRun, log, baseEnv, repoRoot, mintTokenFn });
        break;
      case 'prompt-vercel':
        cur = { ...cur, ...(await promptVercel({ prompt, log, profileName })) };
        break;
      case 'link-vercel':
        linkVercel(cur, { cli, link, log });
        break;
      case 'push-env-vercel':
      case 'first-deploy':
        // Both delegate to vercelRun (it pushes then deploys); split for progress
        // granularity.  Run only on first-deploy; push-env-vercel is a marker.
        if (step === 'first-deploy') {
          cur = await firstDeploy(cur, {
            cli, cliWithStdin, vercelDeployRun, log, baseEnv, repoRoot,
          });
        }
        break;
      case 'wire-auth':
        await wireAuth(cur, { mgmt, log });
        break;
      case 'enable-passkeys':
        await enablePasskeys(cur, { mgmt, log, baseEnv });
        break;
      case 'enable-oauth':
        await enableOauth(cur, { mgmt, log, baseEnv });
        break;
      default:
        throw new Error(`unknown step: ${step}`);
    }
    markProgress(progressPath, step);
  }

  log(`==> done. profile '${profileName}' provisioned.`);
  if (cur.deploymentUrl) log(`==> URL: ${cur.primaryUrl ?? cur.deploymentUrl}`);
  printPostProvisionTips(cur, log);
  return cur;
}

// One-time manual steps users do in the Supabase / Vercel dashboards. Each one
// is non-blocking — if skipped, the corresponding feature degrades gracefully
// rather than failing the rest of provision.
function printPostProvisionTips(cur, log) {
  log('');
  log('==> next steps (one-time dashboard config)');
  log('');
  log('  1. Email OTP login — add the 6-digit code to your Magic Link template:');
  if (cur.projectRef) {
    log(`     https://supabase.com/dashboard/project/${cur.projectRef}/auth/templates`);
  } else {
    log('     Supabase Dashboard → Authentication → Email Templates → Magic Link');
  }
  log('     Replace the body with:');
  log('     ┌─────────────────────────────────────────────────────────────────');
  log('     │ <h2>Sign in to Plannen</h2>');
  log('     │ <p>Tap this link to log in:</p>');
  log('     │ <p><a href="{{ .ConfirmationURL }}">Log In</a></p>');
  log('     │ <p>…or enter this 6-digit code in the app:</p>');
  log('     │ <p style="font-size:24px;letter-spacing:4px;font-weight:700;">{{ .Token }}</p>');
  log('     └─────────────────────────────────────────────────────────────────');
  log('     Without {{ .Token }}, the OTP field on /login has nothing to verify.');
  log('');
  log('  2. Web Push — mirror your local VAPID keys into Vercel env vars:');
  log('     `vercel env add VAPID_PUBLIC_KEY production` (then preview + dev)');
  log('     `vercel env add VAPID_PRIVATE_KEY production`');
  log('     `vercel env add VAPID_SUBJECT production`   (e.g. mailto:you@example.com)');
  log('     Then `npx plannen deploy` to roll the new env into prod.');
  log('     Note: push endpoints currently live on the Hono backend (Tier 0/1).');
  log('     Tier 2 push needs the routes ported to Vercel functions — follow-up.');
  log('');
}

// ── Step implementations ─────────────────────────────────────────────────────

function runPreflight({ cli, mgmt, log }) {
  const supabaseLogin = cli ? cli(['--version']) : { status: 0 };
  if (supabaseLogin.status !== 0) {
    throw new Error('supabase CLI failed --version sanity check');
  }
  const token = mgmt.readAccessToken({});
  if (!token) {
    throw new Error(
      'no Supabase access token found. Run `supabase login` (or set SUPABASE_ACCESS_TOKEN).',
    );
  }
  log('  preflight: ✓ supabase + vercel CLIs reachable, Supabase access token present');
}

async function promptSupabase({ prompt, log }) {
  log('  Open the Supabase dashboard, create your project, then come back here.');
  log('  https://supabase.com/dashboard/new');
  const projectRef = (await prompt('  project ref (e.g. abcd…1234): ')).trim();
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error(`invalid project ref format: ${projectRef}`);
  }
  const region = (await prompt('  region (e.g. eu-west-1): ')).trim();

  // The DB password is only needed if the user plans to migrate data into
  // this cloud DB from a local tier (which runs a direct psql restore).
  // For a standard staging-from-scratch flow it's unnecessary — schema
  // push, function deploys, and Auth config all use the access token.
  log('');
  log('  Do you plan to migrate data from a local tier into this cloud env?');
  log('  Only needed if this is a tier-1 → tier-2 upgrade with existing data.');
  log('  For a fresh staging environment, answer no.');
  const wantMigrate = (await prompt('  Migrate local data? [y/N]: ')).trim().toLowerCase();
  let dbPassword = null;
  if (wantMigrate === 'y' || wantMigrate === 'yes') {
    log('');
    log('  Data migration uses a direct Postgres connection to TRUNCATE the');
    log('  cloud tables and apply your local dump. That requires the DB');
    log('  password from the dashboard → Project Settings → Database.');
    dbPassword = await prompt('  database password: ');
    if (!dbPassword) throw new Error('database password required when migrating data');
  }
  return { projectRef, region, dbPassword };
}

async function linkSupabase(cur, { cli, linkRun, log, baseEnv, repoRoot }) {
  const result = await linkRun({ projectRef: cur.projectRef }, { cli });
  log(`  link-supabase: ✓ linked ${cur.projectRef}`);
  const cloudSupabaseUrl = `https://${cur.projectRef}.supabase.co`;
  // DATABASE_URL only stored when a password was provided (i.e. when the user
  // opted in to data migration). Other operations don't need it.
  const databaseUrl = cur.dbPassword
    ? buildPoolerUrl({
        projectRef: cur.projectRef,
        region: cur.region,
        password: cur.dbPassword,
      })
    : null;
  // Persist into profile env so deploy/promote can read it next time.
  withProfileEnv(cur.profileName, baseEnv, repoRoot, () => ({
    PLANNEN_TIER: '2',
    SUPABASE_PROJECT_REF: cur.projectRef,
    SUPABASE_URL: cloudSupabaseUrl,
    VITE_SUPABASE_URL: cloudSupabaseUrl,
    SUPABASE_ANON_KEY: result.anonKey,
    VITE_SUPABASE_ANON_KEY: result.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: result.serviceRoleKey,
    VITE_PLANNEN_TIER: '2',
    VITE_PLANNEN_BACKEND_MODE: 'supabase',
    ...(databaseUrl ? { DATABASE_URL: databaseUrl, CLOUD_DATABASE_URL: databaseUrl } : {}),
  }));
  return {
    ...cur,
    cloudSupabaseUrl,
    cloudAnonKey: result.anonKey,
    cloudServiceRoleKey: result.serviceRoleKey,
    cloudDatabaseUrl: databaseUrl,
  };
}

function pushSchema(cur, { cli, log }) {
  const c = cli ?? ((args) => spawnSync('supabase', args, { encoding: 'utf8' }));
  const r = c(['db', 'push', '--linked']);
  if (r.status !== 0) {
    throw new Error(`supabase db push --linked → exit ${r.status}: ${r.stderr || r.stdout}`);
  }
  log('  push-schema: ✓ migrations applied to cloud');
}

async function deployFunctions(cur, { cli, deployRun, log, baseEnv, repoRoot, mintTokenFn }) {
  const envPath = getProfileEnvPath(cur.profileName, baseEnv);
  const { ensureVapidKeys } = await import('../../lib/ensure-vapid.mjs');
  const vapid = await ensureVapidKeys({
    envFile: envPath,
    email: cur.PLANNEN_USER_EMAIL ?? '',
    log: { ok: (s) => log(`  ${s}`), warn: (s) => log(`  ⚠ ${s}`) },
  });
  const reread = composeEnv(cur.profileName, {}, baseEnv);
  cur = { ...cur, ...reread };

  const extraSecrets = {
    ...(cur.VAPID_PUBLIC_KEY ? { VAPID_PUBLIC_KEY: cur.VAPID_PUBLIC_KEY } : {}),
    ...(cur.VAPID_PRIVATE_KEY ? { VAPID_PRIVATE_KEY: cur.VAPID_PRIVATE_KEY } : {}),
    ...(cur.VAPID_SUBJECT ? { VAPID_SUBJECT: cur.VAPID_SUBJECT } : {}),
  };

  const result = await deployRun(
    {
      projectRef: cur.projectRef,
      cloudDatabaseUrl: cur.cloudDatabaseUrl,
      userEmail: cur.PLANNEN_USER_EMAIL,
      mcpBearerToken: cur.MCP_BEARER_TOKEN,
      googleClientId: cur.GOOGLE_CLIENT_ID,
      googleClientSecret: cur.GOOGLE_CLIENT_SECRET,
      anthropicApiKey: cur.ANTHROPIC_API_KEY,
      extraSecrets,
    },
    { cli },
  );
  if (vapid.generated) log('  deploy-functions: ✓ VAPID keys pushed to function secrets');
  log(`  deploy-functions: ✓ deployed ${result.deployed?.length ?? 0} function(s)`);

  // Auto-mint admin's first PAT via the userTokens helper.
  // Requires DATABASE_URL (set when the user opted in to data migration or
  // when CLOUD_DATABASE_URL is available from the compose env).
  const dbUrl = cur.cloudDatabaseUrl ?? cur.DATABASE_URL ?? cur.CLOUD_DATABASE_URL;
  if (!dbUrl) {
    log('  deploy-functions: DATABASE_URL not set — skipping PAT mint (no DB connection available)');
    return cur;
  }
  const _mintToken = mintTokenFn ?? mintToken;
  const pool = new pg.Pool({ connectionString: dbUrl });
  let mcpBearerToken;
  try {
    const client = await pool.connect();
    try {
      const userEmail = cur.PLANNEN_USER_EMAIL ?? cur.userEmail;
      if (!userEmail) {
        log('  deploy-functions: PLANNEN_USER_EMAIL not set — skipping PAT mint');
        return cur;
      }
      const u = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [userEmail],
      );
      if (u.rows.length === 0) {
        throw new Error(`provision: plannen.users row for ${userEmail} missing — schema push step did not create it`);
      }
      const r = await _mintToken(client, u.rows[0].id, `provision-${os.hostname()}`);
      mcpBearerToken = r.plaintext;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  withProfileEnv(cur.profileName, baseEnv, repoRoot, () => ({
    MCP_BEARER_TOKEN: mcpBearerToken,
  }));
  return { ...cur, mcpBearerToken };
}

async function promptVercel({ prompt, log, profileName }) {
  log('  Open the Vercel dashboard and create your project (any framework — we set it via vercel.json).');
  log('  https://vercel.com/new');
  const def = `plannen-${profileName}`;
  const projectName = (await prompt(`  vercel project name [${def}]: `)).trim() || def;
  return { vercelProjectName: projectName };
}

function linkVercel(cur, { cli, link, log }) {
  // vercelLink in scripts/lib/vercel-deploy.mjs doesn't take a project arg today
  // (it shells `vercel link --yes`). We invoke it with extra args via the cli
  // dep injection so we can target the named project.
  const c = cli ?? defaultLocalVercelCli;
  const r = c(['link', '--yes', '--project', cur.vercelProjectName]);
  if (r.status !== 0) {
    throw new Error(`vercel link → exit ${r.status}: ${r.stderr || r.stdout}`);
  }
  log(`  link-vercel: ✓ linked to ${cur.vercelProjectName}`);
}

function defaultLocalVercelCli(args) {
  return spawnSync('vercel', args, { encoding: 'utf8' });
}

async function firstDeploy(cur, { cli, cliWithStdin, vercelDeployRun, log, baseEnv, repoRoot }) {
  // Read the (now-populated) profile env as text — vercelRun parses VITE_*.
  const envPath = getProfileEnvPath(cur.profileName, baseEnv);
  const envText = readFileSync(envPath, 'utf8');
  const result = await vercelDeployRun(
    { envText, target: 'production', prod: true },
    { cli, cliWithStdin, log: (s) => log(`  ${s}`) },
  );
  log(`  first-deploy: ✓ ${result.primaryUrl ?? result.deploymentUrl}`);
  if (result.primaryUrl) {
    withProfileEnv(cur.profileName, baseEnv, repoRoot, () => ({
      PLANNEN_WEB_URL: result.primaryUrl,
    }));
  }
  return { ...cur, deploymentUrl: result.deploymentUrl, primaryUrl: result.primaryUrl };
}

async function wireAuth(cur, { mgmt, log }) {
  const token = mgmt.readAccessToken({});
  if (!token) {
    log('  wire-auth: skipping (no Supabase access token; set Site URL + redirect URLs manually)');
    return;
  }
  const siteUrl = cur.primaryUrl ?? cur.deploymentUrl ?? 'http://localhost:4321';
  const result = await mgmt.updateAuthConfig(token, cur.projectRef, {
    siteUrl,
    addAllowList: [`${siteUrl.replace(/\/+$/, '')}/**`],
  });
  log(`  wire-auth: ${result.changed ? '✓ updated' : '✓ already up to date'} site_url=${siteUrl}`);
}

async function enablePasskeys(cur, { mgmt, log, baseEnv }) {
  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    log('  enable-passkeys: skipping (no Supabase access token; run `plannen cloud passkeys enable` later)');
    return;
  }
  const webUrl = cur.primaryUrl ?? cur.deploymentUrl;
  if (!webUrl) {
    log('  enable-passkeys: skipping (no deployment URL yet)');
    return;
  }
  // Delegate origin/RP-ID derivation to passkeys.mjs so the logic stays in one
  // place and the standalone `plannen cloud passkeys enable` command matches.
  const rpId = deriveRpId(webUrl);
  const origins = deriveOrigins(webUrl);
  const result = await mgmt.updatePasskeyConfig(token, cur.projectRef, {
    rpId,
    rpOrigins: origins,
    rpDisplayName: 'Plannen',
  });
  log(`  enable-passkeys: ${result.changed ? '✓ enabled' : '✓ already enabled'} rp_id=${rpId}`);
  void invokePasskeysEnable; // exported for direct CLI invocation; provision uses the lower-level mgmt call so progress is granular.
}

async function enableOauth(cur, { mgmt, log, baseEnv }) {
  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    log('  enable-oauth: skipping (no Supabase access token; run `plannen cloud oauth enable` later)');
    return;
  }
  // Consent path combines with the Site URL set by wire-auth, so the full
  // consent page lives at <web-url>/oauth/consent (served by the web app).
  const result = await mgmt.updateOAuthServerConfig(token, cur.projectRef, {
    authorizationPath: CONSENT_PATH,
  });
  const connectorUrl = `https://${cur.projectRef}.supabase.co/functions/v1/mcp`;
  log(`  enable-oauth: ${result.changed ? '✓ enabled' : '✓ already enabled'}`);
  log(`  enable-oauth: claude.ai connector URL → ${connectorUrl}`);
}

// ── citty wiring ─────────────────────────────────────────────────────────────

export const provisionCommand = defineCommand({
  meta: {
    name: 'provision',
    description: 'Guided one-time setup of a cloud_sb profile (Supabase + Vercel)',
  },
  args: {
    profile: { type: 'string', description: 'Profile to provision (must exist + mode=cloud_sb)', required: true },
  },
  async run({ args }) {
    await invokeProvision(args);
    process.exit(0);
  },
});
