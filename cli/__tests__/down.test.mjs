import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeDown } from '../commands/down.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-down-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

/**
 * Stand-in for runScript that records the script path + env it would have run.
 * Always resolves with the given exitCode — same shape runScript returns.
 */
function makeRunner({ exitCode = 0 } = {}) {
  const calls = [];
  const runScript = vi.fn(async ({ script, env: childEnv }) => {
    calls.push({ script, env: childEnv });
    return exitCode;
  });
  return { runScript, calls };
}

function scriptNames(calls) {
  return calls.map((c) => path.basename(c.script));
}

describe('down', () => {
  it('with no profile: tier defaults to 0, calls dev → backend → pg stop scripts', async () => {
    const { runScript, calls } = makeRunner();
    expect(await invokeDown({}, { env: env(), runScript, log: () => {} })).toBe(0);
    expect(scriptNames(calls)).toEqual(['dev-stop.sh', 'backend-stop.sh', 'pg-stop.sh']);
  });

  it('tolerates sub-script failures (matches former stop.sh `|| true` semantics)', async () => {
    const { runScript } = makeRunner({ exitCode: 5 });
    expect(await invokeDown({}, { env: env(), runScript, log: () => {} })).toBe(0);
  });

  it('tier 2 profile: only dev-stop.sh runs locally; no supabase/pg/backend', async () => {
    await invokeProfileCreate({ name: 'default', mode: 'cloud_sb' }, { env: env(), now });
    setActive('default', env());
    const { runScript, calls } = makeRunner();
    const supabaseCalls = [];
    const spawnSync = vi.fn((cmd, args) => { supabaseCalls.push({ cmd, args }); return { status: 0 }; });
    await invokeDown({}, { env: env(), runScript, spawnSync, log: () => {} });
    expect(scriptNames(calls)).toEqual(['dev-stop.sh']);
    expect(calls[0].env.PLANNEN_PROFILE).toBe('default');
    expect(calls[0].env.PLANNEN_TIER).toBe('2');
    expect(supabaseCalls).toEqual([]);
  });

  it('tier 1 profile: dev → functions-stop → supabase stop', async () => {
    await invokeProfileCreate({ name: 'local', mode: 'local_sb' }, { env: env(), now });
    setActive('local', env());
    const { runScript, calls } = makeRunner();
    const supabaseCalls = [];
    const spawnSync = vi.fn((cmd, args) => { supabaseCalls.push({ cmd, args }); return { status: 0 }; });
    await invokeDown({}, { env: env(), runScript, spawnSync, log: () => {} });
    expect(scriptNames(calls)).toEqual(['dev-stop.sh', 'functions-stop.sh']);
    expect(supabaseCalls).toEqual([{ cmd: 'supabase', args: ['stop', '--project-id', 'plannen'] }]);
  });
});
