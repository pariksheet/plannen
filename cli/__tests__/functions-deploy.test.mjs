import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeFunctionsDeploy } from '../commands/functions/deploy.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive, getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-19T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-functions-deploy-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

/**
 * Create a profile, mark it active, and optionally append extra env vars.
 */
async function withProfile(name, mode, extraEnv = {}) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  setActive(name, env());
  const envPath = getProfileEnvPath(name, env());
  const lines = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}\n`).join('');
  if (lines) appendFileSync(envPath, lines);
}

/**
 * Stub cloudDeployRun that records its call and returns a result with
 * deployedFunctions — mirrors the pattern in promote.test.mjs.
 */
function makeCloudDeployRun(deployedFunctions = ['mcp', 'analyse-source']) {
  return vi.fn(async (ctx) => ({ ...ctx, deployedFunctions }));
}

describe('plannen functions deploy', () => {
  it('deploys via cloudDeploy.run with active profile projectRef', async () => {
    await withProfile('sb_prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abc123defghijklmnopq',
    });

    const cloudDeployRun = makeCloudDeployRun();
    const logs = [];

    const code = await invokeFunctionsDeploy(
      {},
      { env: env(), cloudDeployRun, log: (s) => logs.push(s) },
    );

    expect(code).toBe(0);
    expect(cloudDeployRun).toHaveBeenCalledOnce();
    expect(cloudDeployRun.mock.calls[0][0].projectRef).toBe('abc123defghijklmnopq');
    expect(logs.some((l) => /abc123defghijklmnopq/.test(l))).toBe(true);
    expect(logs.some((l) => /deployed 2 function/i.test(l))).toBe(true);
  });

  it('refuses on Tier < 2 with a clear message', async () => {
    await withProfile('local', 'local_pg');

    const cloudDeployRun = makeCloudDeployRun();

    await expect(
      invokeFunctionsDeploy({}, { env: env(), cloudDeployRun, log: () => {} }),
    ).rejects.toThrow(/Tier 0.*cloud_sb/i);

    expect(cloudDeployRun).not.toHaveBeenCalled();
  });

  it('--profile override uses the specified profile instead of active', async () => {
    // Create 'default' (active) and 'cloud_prod' (override target).
    await withProfile('default', 'local_pg');
    await invokeProfileCreate({ name: 'cloud_prod', mode: 'cloud_sb' }, { env: env(), now });
    appendFileSync(
      getProfileEnvPath('cloud_prod', env()),
      'SUPABASE_PROJECT_REF=override1234567890abc\n',
    );
    // 'default' is already active; 'cloud_prod' is NOT active.

    const cloudDeployRun = makeCloudDeployRun();

    const code = await invokeFunctionsDeploy(
      { profile: 'cloud_prod' },
      { env: env(), cloudDeployRun, log: () => {} },
    );

    expect(code).toBe(0);
    expect(cloudDeployRun).toHaveBeenCalledOnce();
    expect(cloudDeployRun.mock.calls[0][0].projectRef).toBe('override1234567890abc');
  });

  it('bubbles up cloudDeploy.run errors as a thrown error', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'failref12345678901234',
    });

    const cloudDeployRun = vi.fn(async () => {
      throw new Error('supabase functions deploy → exit 1: permission denied');
    });

    await expect(
      invokeFunctionsDeploy({}, { env: env(), cloudDeployRun, log: () => {} }),
    ).rejects.toThrow(/permission denied/);
  });
});
