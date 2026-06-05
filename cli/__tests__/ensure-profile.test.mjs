import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureProfile } from '../lib/ensure-profile.mjs';
import {
  getProfileEnvPath,
  profileExists,
  readEnvFile,
  readManifest,
  resolveActiveProfile,
  writeManifest,
  writeEnvFile,
  swapEnvSymlink,
} from '../lib/profiles.mjs';

let tmpHome;
let tmpRepo;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-ensure-'));
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'plannen-ensure-repo-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
});

function dotenvPath() {
  return path.join(tmpRepo, '.env');
}

describe('ensureProfile — fresh state', () => {
  it('creates default profile and a .env symlink when nothing exists', () => {
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    expect(result.created).toBe(true);
    expect(result.migratedKeys).toEqual([]);
    expect(result.backedUp).toBe(false);

    expect(profileExists('default', env())).toBe(true);
    expect(readManifest('default', env()).mode).toBe('local_pg');

    expect(lstatSync(dotenvPath()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dotenvPath())).toBe(getProfileEnvPath('default', env()));

    expect(resolveActiveProfile(env())).toBe('default');
  });

  it('honours the mode argument when seeding the env file', () => {
    ensureProfile({ env: env(), repoRoot: tmpRepo, name: 'staging', mode: 'cloud_sb', now });
    expect(readEnvFile(getProfileEnvPath('staging', env())).PLANNEN_TIER).toBe('2');
  });
});

describe('ensureProfile — legacy .env regular file', () => {
  it('migrates contents into profile env, backs up the file, swaps symlink', () => {
    writeFileSync(dotenvPath(), 'PLANNEN_USER_EMAIL=me@example.com\nDATABASE_URL=postgres://x\n');
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    expect(result.created).toBe(true);
    expect(result.migratedKeys.sort()).toEqual(['DATABASE_URL', 'PLANNEN_USER_EMAIL']);
    expect(result.backedUp).toBe(true);

    expect(existsSync(`${dotenvPath()}.legacy-backup`)).toBe(true);
    expect(lstatSync(dotenvPath()).isSymbolicLink()).toBe(true);

    const profileEnv = readEnvFile(getProfileEnvPath('default', env()));
    expect(profileEnv.PLANNEN_USER_EMAIL).toBe('me@example.com');
    expect(profileEnv.DATABASE_URL).toBe('postgres://x');
    expect(profileEnv.PLANNEN_TIER).toBe('0');
  });

  it('mode arg overrides a stale PLANNEN_TIER in the legacy .env', () => {
    writeFileSync(dotenvPath(), 'PLANNEN_TIER=1\n');
    ensureProfile({ env: env(), repoRoot: tmpRepo, mode: 'local_pg', now });
    expect(readEnvFile(getProfileEnvPath('default', env())).PLANNEN_TIER).toBe('0');
  });
});

describe('ensureProfile — idempotency', () => {
  it('is a no-op when symlink already points at the profile env', () => {
    ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    const first = readFileSync(getProfileEnvPath('default', env()), 'utf8');
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    expect(result.created).toBe(false);
    expect(result.backedUp).toBe(false);
    expect(readFileSync(getProfileEnvPath('default', env()), 'utf8')).toBe(first);
  });

  it('repairs a broken symlink when profile exists but .env is missing', () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: now() }, env());
    writeEnvFile(getProfileEnvPath('default', env()), { PLANNEN_TIER: '0' });
    // no .env symlink yet
    ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    expect(lstatSync(dotenvPath()).isSymbolicLink()).toBe(true);
  });

  it('when profile exists and .env is a regular file, merges + backs up', () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: now() }, env());
    writeEnvFile(getProfileEnvPath('default', env()), { PLANNEN_TIER: '0', EXISTING: 'old' });
    writeFileSync(dotenvPath(), 'EXISTING=new\nADDED=yes\n');
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    expect(result.backedUp).toBe(true);
    const merged = readEnvFile(getProfileEnvPath('default', env()));
    expect(merged.EXISTING).toBe('new');
    expect(merged.ADDED).toBe('yes');
    expect(merged.PLANNEN_TIER).toBe('0');
  });
});

describe('ensureProfile — non-active target (#13)', () => {
  it('creates the profile but leaves .env on the active profile (create path)', () => {
    ensureProfile({ env: env(), repoRoot: tmpRepo, now }); // 'default' becomes active
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, name: 'side', mode: 'local_pg', now });
    expect(result.created).toBe(true);
    expect(result.symlinkSkipped).toBe(true);
    expect(profileExists('side', env())).toBe(true);
    expect(readlinkSync(dotenvPath())).toBe(getProfileEnvPath('default', env()));
    expect(resolveActiveProfile(env())).toBe('default');
  });

  it('leaves .env alone when re-ensuring an existing non-active profile', () => {
    ensureProfile({ env: env(), repoRoot: tmpRepo, now });
    ensureProfile({ env: env(), repoRoot: tmpRepo, name: 'side', mode: 'local_pg', now });
    const result = ensureProfile({ env: env(), repoRoot: tmpRepo, name: 'side', mode: 'local_pg', now });
    expect(result.created).toBe(false);
    expect(result.symlinkSkipped).toBe(true);
    expect(readlinkSync(dotenvPath())).toBe(getProfileEnvPath('default', env()));
  });
});
