import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeUp } from '../commands/up.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-up-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

/**
 * Stand-in for runScript. Records the script path + env it would have run.
 * Always resolves with the given exitCode.
 */
function makeRunner({ exitCode = 0 } = {}) {
  const calls = [];
  const runScript = vi.fn(async ({ script, env: childEnv, args = [] }) => {
    calls.push({ script, env: childEnv, args });
    return exitCode;
  });
  return { runScript, calls };
}

function scriptNames(calls) {
  return calls.map((c) => path.basename(c.script));
}

async function withProfile(name, mode) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  setActive(name, env());
}

describe('up', () => {
  it('throws when there is no active profile', async () => {
    const { runScript } = makeRunner();
    await expect(invokeUp({}, { env: env(), runScript, log: () => {} })).rejects.toThrow(/no active profile/i);
  });

  it('tier 0 (local_pg): pg-start → backend-start → dev-start', async () => {
    await withProfile('default', 'local_pg');
    const { runScript, calls } = makeRunner();
    const code = await invokeUp({}, { env: env(), runScript, log: () => {} });
    expect(code).toBe(0);
    expect(scriptNames(calls)).toEqual(['pg-start.sh', 'backend-start.sh', 'dev-start.sh']);
  });

  it('tier 1 (local_sb): local-start → functions-start → dev-start', async () => {
    await withProfile('local', 'local_sb');
    const { runScript, calls } = makeRunner();
    await invokeUp({}, { env: env(), runScript, log: () => {} });
    expect(scriptNames(calls)).toEqual(['local-start.sh', 'functions-start.sh', 'dev-start.sh']);
  });

  it('tier 2 (cloud_sb): only dev-start runs locally', async () => {
    await withProfile('prod', 'cloud_sb');
    const { runScript, calls } = makeRunner();
    await invokeUp({}, { env: env(), runScript, log: () => {} });
    expect(scriptNames(calls)).toEqual(['dev-start.sh']);
  });

  it('--no-dev skips the dev server', async () => {
    await withProfile('default', 'local_pg');
    const { runScript, calls } = makeRunner();
    await invokeUp({ 'no-dev': true }, { env: env(), runScript, log: () => {} });
    expect(scriptNames(calls)).toEqual(['pg-start.sh', 'backend-start.sh']);
  });

  it('bails early when a sub-script fails (returns its exit code)', async () => {
    await withProfile('default', 'local_pg');
    const { runScript, calls } = makeRunner({ exitCode: 3 });
    const code = await invokeUp({}, { env: env(), runScript, log: () => {} });
    expect(code).toBe(3);
    // Only the first script runs before we bail.
    expect(calls).toHaveLength(1);
  });

  it('honours --profile override even when a different active profile exists', async () => {
    await invokeProfileCreate({ name: 'staging', mode: 'cloud_sb' }, { env: env(), now });
    await invokeProfileCreate({ name: 'default', mode: 'local_pg' }, { env: env(), now });
    setActive('default', env());
    const { runScript, calls } = makeRunner();
    await invokeUp({ profile: 'staging' }, { env: env(), runScript, log: () => {} });
    // Tier 2 → only dev-start.sh; check the env it carries.
    expect(scriptNames(calls)).toEqual(['dev-start.sh']);
    expect(calls[0].env.PLANNEN_TIER).toBe('2');
    expect(calls[0].env.PLANNEN_PROFILE).toBe('staging');
  });

  it('rejects an unknown profile', async () => {
    const { runScript } = makeRunner();
    await expect(invokeUp({ profile: 'ghost' }, { env: env(), runScript, log: () => {} })).rejects.toThrow(/does not exist/);
  });
});
