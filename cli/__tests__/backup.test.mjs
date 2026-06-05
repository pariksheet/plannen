import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeBackup } from '../commands/backup.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive, getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-19T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-backup-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

function makeRunner({ exitCode = 0 } = {}) {
  const calls = [];
  const runScript = vi.fn(async ({ script, env: childEnv, args = [] }) => {
    calls.push({ script, env: childEnv, args });
    return exitCode;
  });
  return { runScript, calls };
}

async function withProfile(name, mode, extraEnv = {}) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  setActive(name, env());
  const envPath = getProfileEnvPath(name, env());
  const lines = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}\n`).join('');
  if (lines) appendFileSync(envPath, lines);
}

describe('backup', () => {
  it('throws when there is no active profile', async () => {
    const { runScript } = makeRunner();
    await expect(invokeBackup({}, { env: env(), runScript, log: () => {} }))
      .rejects.toThrow(/no active profile/i);
  });

  it('rejects an unknown profile', async () => {
    const { runScript } = makeRunner();
    await expect(invokeBackup({ profile: 'ghost' }, { env: env(), runScript, log: () => {} }))
      .rejects.toThrow(/does not exist/);
  });

  it('tier 0: runs export-seed.sh with PLANNEN_TIER=0 in env', async () => {
    await withProfile('default', 'local_pg');
    const { runScript, calls } = makeRunner();
    const code = await invokeBackup({}, { env: env(), runScript, log: () => {} });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(path.basename(calls[0].script)).toBe('export-seed.sh');
    expect(calls[0].env.PLANNEN_TIER).toBe('0');
  });

  it('tier 1: runs export-seed.sh with PLANNEN_TIER=1', async () => {
    await withProfile('local', 'local_sb');
    const { runScript, calls } = makeRunner();
    await invokeBackup({}, { env: env(), runScript, log: () => {} });
    expect(calls[0].env.PLANNEN_TIER).toBe('1');
  });

  it('tier 2: forwards CLOUD_DATABASE_URL + VITE_SUPABASE_URL + SERVICE_ROLE_KEY', async () => {
    await withProfile('prod', 'cloud_sb', {
      CLOUD_DATABASE_URL: 'postgresql://postgres.abc:pwd@aws-0-eu.pooler.supabase.com:6543/postgres',
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-key-xxx',
    });
    const { runScript, calls } = makeRunner();
    await invokeBackup({}, { env: env(), runScript, log: () => {} });
    expect(calls[0].env.PLANNEN_TIER).toBe('2');
    expect(calls[0].env.CLOUD_DATABASE_URL).toContain('pooler.supabase.com');
    expect(calls[0].env.VITE_SUPABASE_URL).toBe('https://abc.supabase.co');
    expect(calls[0].env.SUPABASE_SERVICE_ROLE_KEY).toBe('svc-key-xxx');
  });

  it('honours --profile override over the active profile', async () => {
    await invokeProfileCreate({ name: 'staging', mode: 'cloud_sb' }, { env: env(), now });
    appendFileSync(getProfileEnvPath('staging', env()), 'CLOUD_DATABASE_URL=postgres://x:y@host/db\n');
    await invokeProfileCreate({ name: 'default', mode: 'local_pg' }, { env: env(), now });
    setActive('default', env());
    const { runScript, calls } = makeRunner();
    await invokeBackup({ profile: 'staging' }, { env: env(), runScript, log: () => {} });
    expect(calls[0].env.PLANNEN_TIER).toBe('2');
    expect(calls[0].env.PLANNEN_PROFILE).toBe('staging');
    expect(calls[0].env.CLOUD_DATABASE_URL).toContain('host/db');
  });

  it('propagates the script exit code', async () => {
    await withProfile('default', 'local_pg');
    const { runScript } = makeRunner({ exitCode: 4 });
    const code = await invokeBackup({}, { env: env(), runScript, log: () => {} });
    expect(code).toBe(4);
  });
});
