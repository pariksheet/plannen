import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('pg', () => ({
  default: {
    Pool: class FakePool {
      async connect() {
        return {
          query: async (sql) => {
            if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u-admin' }], rowCount: 1 };
            if (sql.includes('INSERT INTO plannen.user_tokens')) return { rows: [{ id: 'tok-1' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        };
      }
      async end() {}
    },
  },
}));

import {
  invokeProvision,
  STEPS,
  progressPathFor,
  readProgress,
  markProgress,
  pendingSteps,
} from '../commands/cloud/provision.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { getProfileEnvPath, readEnvFile, writeEnvFile } from '../lib/profiles.mjs';

let tmpHome;
let tmpRepo;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-provision-'));
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'plannen-provision-repo-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
});

// Pre-set prompt answers in order, with sensible defaults for the staging case.
function scriptedPrompts(answers = {}) {
  const q = {
    'project ref': 'abcdefghijklmnopqrst',  // 20 lowercase alphanums
    'region': 'eu-west-1',
    'migrate local data': 'N',              // default: no migration → no password prompt
    'database password': 'sup3rsecret',
    'vercel project name': 'plannen-staging',
    ...answers,
  };
  return async (question) => {
    for (const [key, val] of Object.entries(q)) {
      if (question.toLowerCase().includes(key)) return val;
    }
    return '';
  };
}

// Mock supabaseMgmt with reasonable defaults; tests can override per-call.
function makeMgmt(overrides = {}) {
  return {
    readAccessToken: () => 'fake-token',
    listProjects: async () => [],
    getAuthConfig: async () => ({ siteUrl: '', uriAllowList: [] }),
    updateAuthConfig: async () => ({ changed: true }),
    updatePasskeyConfig: async () => ({ changed: true }),
    updateOAuthServerConfig: async () => ({ changed: true }),
    setExposedSchemas: async () => ({ changed: true }),
    mergeAllowList: (cur, add) => [...new Set([...(cur ?? []), ...add])],
    ...overrides,
  };
}

// Default fakes for the dep-injected `*Run` helpers from scripts/lib/.
// Use plain async functions (not module-level vi.fn) so per-test wrappers
// give clean call counters.
const fakeLinkRun = async () => ({
  anonKey: 'eyJ.anon',
  serviceRoleKey: 'eyJ.svc',
  cloudSupabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
});
const fakeDeployRun = async () => ({
  deployed: ['mcp', 'memory-transcribe'],
});
const fakeVercelRun = async () => ({
  deploymentUrl: 'https://plannen-x.vercel.app',
  primaryUrl: 'https://plannen.vercel.app',
  stableUrl: 'https://plannen.vercel.app',
  pushedKeys: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'],
});

function makeOkCli() {
  return vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
}

function happyCtx(extra = {}) {
  return {
    env: env(),
    repoRoot: tmpRepo,
    log: () => {},
    prompt: scriptedPrompts(),
    ensureBin: () => {},
    cli: makeOkCli(),
    cliWithStdin: makeOkCli(),
    supabaseMgmt: makeMgmt(),
    cloudLinkRun: fakeLinkRun,
    cloudDeployRun: fakeDeployRun,
    vercelRun: fakeVercelRun,
    vercelLink: () => {},
    ...extra,
  };
}

async function withProfile(name = 'staging', mode = 'cloud_sb') {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
}

describe('progress helpers', () => {
  it('readProgress returns an empty set for a missing file', () => {
    expect(readProgress(path.join(tmpRepo, 'nope'))).toEqual(new Set());
  });

  it('markProgress appends + readProgress round-trips', () => {
    const p = path.join(tmpRepo, 'progress');
    markProgress(p, 'a');
    markProgress(p, 'b');
    expect(readProgress(p)).toEqual(new Set(['a', 'b']));
  });

  it('pendingSteps removes already-done', () => {
    expect(pendingSteps(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
  });

  it('STEPS includes all 11 stages in order', () => {
    expect(STEPS).toEqual([
      'preflight',
      'prompt-supabase',
      'link-supabase',
      'push-schema',
      'deploy-functions',
      'prompt-vercel',
      'link-vercel',
      'push-env-vercel',
      'first-deploy',
      'wire-auth',
      'enable-passkeys',
      'enable-oauth',
    ]);
  });

  it('includes enable-oauth as the final step', () => {
    expect(STEPS[STEPS.length - 1]).toBe('enable-oauth');
  });
});

describe('cloud provision — input validation', () => {
  it('requires --profile', async () => {
    await expect(invokeProvision({}, happyCtx())).rejects.toThrow(/profile.*required/i);
  });

  it('refuses a non-existent profile', async () => {
    await expect(invokeProvision({ profile: 'ghost' }, happyCtx())).rejects.toThrow(/does not exist/);
  });

  it('refuses a profile whose mode is not cloud_sb', async () => {
    await withProfile('staging', 'local_pg');
    await expect(invokeProvision({ profile: 'staging' }, happyCtx())).rejects.toThrow(/cloud_sb required/);
  });

  it('refuses if Supabase access token is missing', async () => {
    await withProfile();
    const ctx = happyCtx({ supabaseMgmt: makeMgmt({ readAccessToken: () => null }) });
    await expect(invokeProvision({ profile: 'staging' }, ctx)).rejects.toThrow(/access token/);
  });

  it('refuses an invalid project ref format from the user', async () => {
    await withProfile();
    const ctx = happyCtx({
      prompt: scriptedPrompts({ 'project ref': 'TOO-SHORT' }),
    });
    await expect(invokeProvision({ profile: 'staging' }, ctx)).rejects.toThrow(/project ref/);
  });

  it('requires a password when the user answers yes to data migration', async () => {
    await withProfile();
    const ctx = happyCtx({
      prompt: scriptedPrompts({ 'migrate local data': 'y', 'database password': '' }),
    });
    await expect(invokeProvision({ profile: 'staging' }, ctx)).rejects.toThrow(/password required/i);
  });
});

describe('cloud provision — happy path', () => {
  it('runs all 12 steps end-to-end (no migration) and persists Supabase + cloud values into the profile env', async () => {
    await withProfile();
    // Pre-populate DATABASE_URL + PLANNEN_USER_EMAIL so the PAT-mint step can
    // connect (via the mocked pg.Pool) and write MCP_BEARER_TOKEN.
    writeEnvFile(getProfileEnvPath('staging', env()), {
      DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/plannen',
      PLANNEN_USER_EMAIL: 'admin@example.com',
    });
    const updateOAuthServerConfig = vi.fn(async () => ({ changed: true }));
    const ctx = happyCtx({
      supabaseMgmt: makeMgmt({ updateOAuthServerConfig }),
    });
    const result = await invokeProvision({ profile: 'staging' }, ctx);

    // Progress file has every step
    const done = readProgress(progressPathFor(tmpRepo, 'staging'));
    expect(done).toEqual(new Set(STEPS));

    // Profile env has the cloud values
    const profEnv = readEnvFile(getProfileEnvPath('staging', env()));
    expect(profEnv.PLANNEN_TIER).toBe('2');
    expect(profEnv.SUPABASE_PROJECT_REF).toBe('abcdefghijklmnopqrst');
    expect(profEnv.SUPABASE_URL).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(profEnv.SUPABASE_ANON_KEY).toBe('eyJ.anon');
    expect(profEnv.SUPABASE_SERVICE_ROLE_KEY).toBe('eyJ.svc');
    expect(profEnv.MCP_BEARER_TOKEN).toMatch(/^plnnn_/);
    expect(profEnv.MCP_BEARER_TOKEN.length).toBeGreaterThanOrEqual(48);
    expect(profEnv.PLANNEN_WEB_URL).toBe('https://plannen.vercel.app');

    expect(result.primaryUrl).toBe('https://plannen.vercel.app');

    // enable-oauth step must have called updateOAuthServerConfig exactly once
    expect(updateOAuthServerConfig).toHaveBeenCalledTimes(1);
  });

  it('stores DATABASE_URL when the user opts in to data migration', async () => {
    await withProfile();
    const ctx = happyCtx({
      prompt: scriptedPrompts({ 'migrate local data': 'y', 'database password': 'pw-with-special:chars' }),
    });
    await invokeProvision({ profile: 'staging' }, ctx);
    const profEnv = readEnvFile(getProfileEnvPath('staging', env()));
    expect(profEnv.DATABASE_URL).toMatch(/postgresql:\/\/postgres\.abcdefghijklmnopqrst:/);
    expect(profEnv.DATABASE_URL).toMatch(/aws-0-eu-west-1\.pooler\.supabase\.com:6543/);
    // Special chars in password should be percent-encoded
    expect(profEnv.DATABASE_URL).toContain('pw-with-special%3Achars');
    expect(profEnv.CLOUD_DATABASE_URL).toBe(profEnv.DATABASE_URL);
  });

  it('resumes from progress: skips done steps and only runs remaining', async () => {
    await withProfile();
    // Pre-mark the first 5 steps as done.
    const progressPath = progressPathFor(tmpRepo, 'staging');
    for (const s of STEPS.slice(0, 5)) markProgress(progressPath, s);

    const linkRun = vi.fn(fakeLinkRun);
    const deployRun = vi.fn(fakeDeployRun);
    const vercelRun = vi.fn(fakeVercelRun);
    const ctx = happyCtx({
      cloudLinkRun: linkRun,
      cloudDeployRun: deployRun,
      vercelRun,
    });
    await invokeProvision({ profile: 'staging' }, ctx);

    // First 5 (preflight … deploy-functions) should NOT have been called
    expect(linkRun).not.toHaveBeenCalled();
    expect(deployRun).not.toHaveBeenCalled();
    // first-deploy runs (it's step 9, not in the skipped 5)
    expect(vercelRun).toHaveBeenCalledTimes(1);

    // Progress file should now have all 10
    expect(readProgress(progressPath).size).toBe(STEPS.length);
  });

  it('is a no-op when all steps already completed', async () => {
    await withProfile();
    const progressPath = progressPathFor(tmpRepo, 'staging');
    for (const s of STEPS) markProgress(progressPath, s);
    const linkRun = vi.fn(fakeLinkRun);
    const ctx = happyCtx({ cloudLinkRun: linkRun });
    const result = await invokeProvision({ profile: 'staging' }, ctx);
    expect(result).toEqual({ skipped: true });
    expect(linkRun).not.toHaveBeenCalled();
  });
});

describe('cloud provision — wire-auth fallback', () => {
  it('logs a skip message when Supabase access token is gone by the wire-auth step', async () => {
    await withProfile();
    let tokenReads = 0;
    const ctx = happyCtx({
      supabaseMgmt: makeMgmt({
        readAccessToken: () => {
          tokenReads++;
          // First call (preflight) sees a token; later calls (wire-auth) don't.
          return tokenReads === 1 ? 'fake-token' : null;
        },
      }),
    });
    const logs = [];
    ctx.log = (s) => logs.push(s);
    await invokeProvision({ profile: 'staging' }, ctx);
    expect(logs.join('\n')).toMatch(/wire-auth: skipping/);
  });
});
