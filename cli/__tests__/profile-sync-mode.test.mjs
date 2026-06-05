import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeProfileSyncMode } from '../commands/profile/sync-mode.mjs';
import {
  getProfileEnvPath,
  readManifest,
  setActive,
  writeEnvFile,
  writeManifest,
} from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });

function makeIO() {
  const out = [];
  const err = [];
  return {
    out: { write: (s) => out.push(String(s)) },
    err: { write: (s) => err.push(String(s)) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function seed(name, manifestMode, tier) {
  writeManifest(name, { name, mode: manifestMode, port_offset: 0, created_at: 'x' }, env());
  writeEnvFile(getProfileEnvPath(name, env()), { PLANNEN_TIER: tier });
}

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-sync-mode-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

describe('profile sync-mode', () => {
  it('rewrites manifest.mode when drifted and reports the change', async () => {
    seed('default', 'local_pg', '2');
    const io = makeIO();
    const code = await invokeProfileSyncMode({ name: 'default' }, { env: env(), out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.stdout()).toMatch(/local_pg → cloud_sb/);
    expect(readManifest('default', env()).mode).toBe('cloud_sb');
  });

  it('says "already in sync" when manifest matches', async () => {
    seed('p', 'local_pg', '0');
    const io = makeIO();
    await invokeProfileSyncMode({ name: 'p' }, { env: env(), out: io.out, err: io.err });
    expect(io.stdout()).toMatch(/already in sync/);
  });

  it('--quiet suppresses no-change output', async () => {
    seed('p', 'local_pg', '0');
    const io = makeIO();
    await invokeProfileSyncMode({ name: 'p', quiet: true }, { env: env(), out: io.out, err: io.err });
    expect(io.stdout()).toBe('');
  });

  it('--json emits structured result', async () => {
    seed('default', 'local_pg', '2');
    const io = makeIO();
    await invokeProfileSyncMode({ name: 'default', json: true }, { env: env(), out: io.out, err: io.err });
    const parsed = JSON.parse(io.stdout());
    expect(parsed).toMatchObject({ name: 'default', changed: true, before: 'local_pg', after: 'cloud_sb' });
  });

  it('defaults to the active profile when no name given', async () => {
    seed('staging', 'local_pg', '2');
    setActive('staging', env());
    const io = makeIO();
    const code = await invokeProfileSyncMode({}, { env: env(), out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(readManifest('staging', env()).mode).toBe('cloud_sb');
  });

  it('fails when no name and no active profile', async () => {
    const io = makeIO();
    const code = await invokeProfileSyncMode({}, { env: env(), out: io.out, err: io.err });
    expect(code).toBe(1);
    expect(io.stderr()).toMatch(/no profile name/);
  });

  it('fails when profile does not exist', async () => {
    const io = makeIO();
    const code = await invokeProfileSyncMode({ name: 'ghost' }, { env: env(), out: io.out, err: io.err });
    expect(code).toBe(1);
    expect(io.stderr()).toMatch(/profile not found/);
  });
});
