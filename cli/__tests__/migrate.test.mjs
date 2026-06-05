import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { invokeMigrate } from '../commands/migrate.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive, getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-19T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-migrate-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

/**
 * Stand-in for child_process.spawn. Returns a fake child that emits 'exit'
 * with the supplied exitCode on the next tick. Records the spawn call so
 * tests can assert on cmd/args/env.
 */
function makeSpawner({ exitCode = 0, signal = null } = {}) {
  const calls = [];
  const spawner = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', exitCode, signal));
    return child;
  });
  return { spawner, calls };
}

async function withProfile(name, mode, extraEnv = {}) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  setActive(name, env());
  // The profile env file only has PLANNEN_TIER + ports out of the box; tests
  // append the runtime keys (DATABASE_URL, SUPABASE_PROJECT_REF) that init or
  // cloud-provision would normally fill in.
  const envPath = getProfileEnvPath(name, env());
  const lines = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}\n`).join('');
  if (lines) appendFileSync(envPath, lines);
}

describe('migrate', () => {
  it('throws when there is no active profile', async () => {
    const { spawner } = makeSpawner();
    await expect(invokeMigrate({}, { env: env(), spawner, log: () => {} }))
      .rejects.toThrow(/no active profile/i);
  });

  it('rejects an unknown profile', async () => {
    const { spawner } = makeSpawner();
    await expect(invokeMigrate({ profile: 'ghost' }, { env: env(), spawner, log: () => {} }))
      .rejects.toThrow(/does not exist/);
  });

  it('tier 0: spawns node migrate.mjs with PLANNEN_TIER=0 + DATABASE_URL', async () => {
    await withProfile('default', 'local_pg', {
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
    });
    const { spawner, calls } = makeSpawner();
    const code = await invokeMigrate({}, { env: env(), spawner, log: () => {} });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('node');
    expect(path.basename(calls[0].args[0])).toBe('migrate.mjs');
    expect(calls[0].opts.env.PLANNEN_TIER).toBe('0');
    expect(calls[0].opts.env.DATABASE_URL).toContain('54322');
  });

  it('tier 1: spawns with PLANNEN_TIER=1', async () => {
    await withProfile('local', 'local_sb', {
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
    });
    const { spawner, calls } = makeSpawner();
    await invokeMigrate({}, { env: env(), spawner, log: () => {} });
    expect(calls[0].opts.env.PLANNEN_TIER).toBe('1');
  });

  it('tier 2: spawns with PLANNEN_TIER=2 and SUPABASE_PROJECT_REF', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    });
    const { spawner, calls } = makeSpawner();
    await invokeMigrate({}, { env: env(), spawner, log: () => {} });
    expect(calls[0].opts.env.PLANNEN_TIER).toBe('2');
    expect(calls[0].opts.env.SUPABASE_PROJECT_REF).toBe('abcdefghijklmnopqrst');
  });

  it('honours --profile override over the active profile', async () => {
    await invokeProfileCreate({ name: 'staging', mode: 'cloud_sb' }, { env: env(), now });
    appendFileSync(getProfileEnvPath('staging', env()), 'SUPABASE_PROJECT_REF=staging1234567890abcd\n');
    await invokeProfileCreate({ name: 'default', mode: 'local_pg' }, { env: env(), now });
    setActive('default', env());
    const { spawner, calls } = makeSpawner();
    await invokeMigrate({ profile: 'staging' }, { env: env(), spawner, log: () => {} });
    expect(calls[0].opts.env.PLANNEN_TIER).toBe('2');
    expect(calls[0].opts.env.PLANNEN_PROFILE).toBe('staging');
    expect(calls[0].opts.env.SUPABASE_PROJECT_REF).toBe('staging1234567890abcd');
  });

  it('propagates a non-zero exit code from the migration runner', async () => {
    await withProfile('default', 'local_pg', {
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
    });
    const { spawner } = makeSpawner({ exitCode: 7 });
    const code = await invokeMigrate({}, { env: env(), spawner, log: () => {} });
    expect(code).toBe(7);
  });
});
