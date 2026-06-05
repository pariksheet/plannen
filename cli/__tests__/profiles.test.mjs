import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getPlannenHome,
  getProfilesDir,
  getProfileDir,
  getProfileManifestPath,
  getProfileEnvPath,
  resolveActiveProfile,
  readManifest,
  writeManifest,
  listProfiles,
  profileExists,
  parseEnvText,
  readEnvFile,
  writeEnvFile,
  nextPortOffset,
  composeEnv,
  setActive,
  VALID_MODES,
  tierToMode,
  syncManifestMode,
  detectModeDrift,
} from '../lib/profiles.mjs';

let tmpHome;
function makeEnv(extra = {}) {
  return { HOME: tmpHome, ...extra };
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-profiles-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('paths', () => {
  it('getPlannenHome honours PLANNEN_HOME over HOME', () => {
    const override = path.join(tmpHome, 'custom');
    expect(getPlannenHome(makeEnv({ PLANNEN_HOME: override }))).toBe(override);
  });

  it('getPlannenHome falls back to $HOME/.plannen', () => {
    expect(getPlannenHome(makeEnv())).toBe(path.join(tmpHome, '.plannen'));
  });

  it('derived paths nest correctly under home', () => {
    const env = makeEnv();
    expect(getProfilesDir(env)).toBe(path.join(tmpHome, '.plannen', 'profiles'));
    expect(getProfileDir('staging', env)).toBe(path.join(tmpHome, '.plannen', 'profiles', 'staging'));
    expect(getProfileManifestPath('staging', env)).toBe(path.join(tmpHome, '.plannen', 'profiles', 'staging', 'profile.json'));
    expect(getProfileEnvPath('staging', env)).toBe(path.join(tmpHome, '.plannen', 'profiles', 'staging', 'env'));
  });
});

describe('manifest io', () => {
  it('writeManifest creates dirs and round-trips with readManifest', () => {
    const env = makeEnv();
    const manifest = { name: 'default', mode: 'local_pg', port_offset: 0, created_at: '2026-05-18T00:00:00Z' };
    writeManifest('default', manifest, env);
    expect(readManifest('default', env)).toEqual(manifest);
  });

  it('readManifest throws on missing profile', () => {
    expect(() => readManifest('ghost', makeEnv())).toThrow(/ghost/);
  });

  it('profileExists is false when no manifest, true after write', () => {
    const env = makeEnv();
    expect(profileExists('p1', env)).toBe(false);
    writeManifest('p1', { name: 'p1', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    expect(profileExists('p1', env)).toBe(true);
  });

  it('listProfiles is empty when dir does not exist', () => {
    expect(listProfiles(makeEnv())).toEqual([]);
  });

  it('listProfiles returns each valid manifest sorted by name', () => {
    const env = makeEnv();
    writeManifest('staging', { name: 'staging', mode: 'cloud_sb', port_offset: 100, created_at: 'b' }, env);
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env);
    const all = listProfiles(env);
    expect(all.map(p => p.name)).toEqual(['default', 'staging']);
  });

  it('listProfiles skips dirs without a manifest', () => {
    const env = makeEnv();
    mkdirSync(getProfileDir('half-baked', env), { recursive: true });
    writeManifest('real', { name: 'real', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    expect(listProfiles(env).map(p => p.name)).toEqual(['real']);
  });
});

describe('env file io', () => {
  it('parseEnvText handles KEY=VALUE, comments, blank lines, surrounding quotes', () => {
    const text = [
      '# leading comment',
      'PLANNEN_TIER=0',
      '',
      'DATABASE_URL="postgres://localhost/x"',
      "ANON_KEY='abc'",
      '   PORT=4321   ',
      'BAD_LINE_NO_EQUALS',
    ].join('\n');
    expect(parseEnvText(text)).toEqual({
      PLANNEN_TIER: '0',
      DATABASE_URL: 'postgres://localhost/x',
      ANON_KEY: 'abc',
      PORT: '4321',
    });
  });

  it('readEnvFile returns {} for missing file', () => {
    expect(readEnvFile(path.join(tmpHome, 'nope'))).toEqual({});
  });

  it('writeEnvFile writes mode 0600 and round-trips', () => {
    const p = path.join(tmpHome, 'env');
    writeEnvFile(p, { A: '1', B: 'hello world', C: 'has "quotes"' });
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    const round = readEnvFile(p);
    expect(round).toEqual({ A: '1', B: 'hello world', C: 'has "quotes"' });
  });
});

describe('active-profile resolution', () => {
  it('returns null when nothing set', () => {
    expect(resolveActiveProfile(makeEnv())).toBe(null);
  });

  it('reads ~/.plannen/active when present', () => {
    const env = makeEnv();
    mkdirSync(getPlannenHome(env), { recursive: true });
    writeFileSync(path.join(getPlannenHome(env), 'active'), 'staging\n');
    expect(resolveActiveProfile(env)).toBe('staging');
  });

  it('PLANNEN_PROFILE env-var wins over the active file', () => {
    const env = makeEnv({ PLANNEN_PROFILE: 'override' });
    mkdirSync(getPlannenHome(env), { recursive: true });
    writeFileSync(path.join(getPlannenHome(env), 'active'), 'staging\n');
    expect(resolveActiveProfile(env)).toBe('override');
  });

  it('setActive writes the file (creating dirs as needed)', () => {
    const env = makeEnv();
    setActive('default', env);
    expect(readFileSync(path.join(getPlannenHome(env), 'active'), 'utf8').trim()).toBe('default');
  });

  it('setActive(null) removes the pointer file', () => {
    const env = makeEnv();
    setActive('default', env);
    setActive(null, env);
    expect(existsSync(path.join(getPlannenHome(env), 'active'))).toBe(false);
  });
});

describe('port allocator', () => {
  it('first profile gets offset 0', () => {
    expect(nextPortOffset(makeEnv())).toBe(0);
  });

  it('second profile gets offset 100', () => {
    const env = makeEnv();
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env);
    expect(nextPortOffset(env)).toBe(100);
  });

  it('fills gaps with the smallest unused offset', () => {
    const env = makeEnv();
    writeManifest('a', { name: 'a', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    writeManifest('c', { name: 'c', mode: 'local_pg', port_offset: 200, created_at: 'x' }, env);
    expect(nextPortOffset(env)).toBe(100);
  });
});

describe('composeEnv', () => {
  it('layers process.env → profile env → CLI-injected → overrides', () => {
    const env = makeEnv({ FROM_PROCESS: 'p', SHARED: 'process-wins?' });
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    writeEnvFile(getProfileEnvPath('default', env), {
      PLANNEN_TIER: '0',
      SHARED: 'profile-wins',
      ONLY_PROFILE: 'q',
    });
    const composed = composeEnv('default', { ONLY_OVERRIDE: 'o', SHARED: 'override-wins' }, env);
    expect(composed.FROM_PROCESS).toBe('p');
    expect(composed.PLANNEN_TIER).toBe('0');
    expect(composed.ONLY_PROFILE).toBe('q');
    expect(composed.ONLY_OVERRIDE).toBe('o');
    expect(composed.SHARED).toBe('override-wins');
    expect(composed.PLANNEN_PROFILE).toBe('default');
    expect(composed.PLANNEN_PROFILE_DIR).toBe(getProfileDir('default', env));
  });
});

describe('VALID_MODES', () => {
  it('lists the three canonical modes', () => {
    expect(VALID_MODES).toEqual(['local_pg', 'local_sb', 'cloud_sb']);
  });
});

describe('tierToMode', () => {
  it('maps 0/1/2 to canonical modes', () => {
    expect(tierToMode('0')).toBe('local_pg');
    expect(tierToMode('1')).toBe('local_sb');
    expect(tierToMode('2')).toBe('cloud_sb');
  });

  it('coerces numeric inputs', () => {
    expect(tierToMode(2)).toBe('cloud_sb');
  });

  it('returns undefined for unknown tiers', () => {
    expect(tierToMode('9')).toBeUndefined();
    expect(tierToMode('')).toBeUndefined();
  });
});

describe('syncManifestMode', () => {
  function setup(env, name, manifestMode, envTier) {
    writeManifest(name, { name, mode: manifestMode, port_offset: 0, created_at: 'x' }, env);
    writeEnvFile(getProfileEnvPath(name, env), envTier == null ? {} : { PLANNEN_TIER: envTier });
  }

  it('is a no-op when manifest already matches env tier', () => {
    const env = makeEnv();
    setup(env, 'p', 'local_pg', '0');
    const r = syncManifestMode({ name: 'p', env });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('in-sync');
    expect(readManifest('p', env).mode).toBe('local_pg');
  });

  it('rewrites manifest.mode when env tier disagrees (the issue #23 case)', () => {
    const env = makeEnv();
    setup(env, 'default', 'local_pg', '2');
    const r = syncManifestMode({ name: 'default', env });
    expect(r).toMatchObject({ changed: true, before: 'local_pg', after: 'cloud_sb' });
    expect(readManifest('default', env).mode).toBe('cloud_sb');
  });

  it('preserves manifest fields outside mode', () => {
    const env = makeEnv();
    writeManifest('p', { name: 'p', mode: 'local_pg', port_offset: 200, created_at: 'orig' }, env);
    writeEnvFile(getProfileEnvPath('p', env), { PLANNEN_TIER: '1' });
    syncManifestMode({ name: 'p', env });
    const m = readManifest('p', env);
    expect(m).toEqual({ name: 'p', mode: 'local_sb', port_offset: 200, created_at: 'orig' });
  });

  it('no-ops when profile does not exist', () => {
    expect(syncManifestMode({ name: 'ghost', env: makeEnv() })).toEqual({ changed: false, reason: 'no-profile' });
  });

  it('no-ops when env file has no PLANNEN_TIER', () => {
    const env = makeEnv();
    setup(env, 'p', 'local_pg', null);
    expect(syncManifestMode({ name: 'p', env })).toEqual({ changed: false, reason: 'no-tier' });
  });

  it('no-ops when env tier is unknown', () => {
    const env = makeEnv();
    setup(env, 'p', 'local_pg', '9');
    const r = syncManifestMode({ name: 'p', env });
    expect(r).toMatchObject({ changed: false, reason: 'unknown-tier', tier: '9' });
  });

  it('no-ops in synthetic mode', () => {
    const env = makeEnv({ PLANNEN_PROFILE_FROM_ENV: '1' });
    expect(syncManifestMode({ name: 'whatever', env })).toEqual({ changed: false, reason: 'synthetic' });
  });

  it('no-ops with no name', () => {
    expect(syncManifestMode({ env: makeEnv() })).toEqual({ changed: false, reason: 'no-name' });
  });
});

describe('detectModeDrift', () => {
  it('returns null when in sync', () => {
    const env = makeEnv();
    writeManifest('p', { name: 'p', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    writeEnvFile(getProfileEnvPath('p', env), { PLANNEN_TIER: '0' });
    expect(detectModeDrift({ name: 'p', env })).toBe(null);
  });

  it('describes drift when manifest and env disagree', () => {
    const env = makeEnv();
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    writeEnvFile(getProfileEnvPath('default', env), { PLANNEN_TIER: '2' });
    expect(detectModeDrift({ name: 'default', env })).toEqual({
      manifest_mode: 'local_pg',
      env_tier: '2',
      expected_mode: 'cloud_sb',
    });
  });

  it('returns null for missing profile / no tier / unknown tier / synthetic', () => {
    const env = makeEnv();
    expect(detectModeDrift({ name: 'ghost', env })).toBe(null);
    writeManifest('p', { name: 'p', mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
    expect(detectModeDrift({ name: 'p', env })).toBe(null);
    writeEnvFile(getProfileEnvPath('p', env), { PLANNEN_TIER: '9' });
    expect(detectModeDrift({ name: 'p', env })).toBe(null);
    expect(detectModeDrift({ name: 'p', env: makeEnv({ PLANNEN_PROFILE_FROM_ENV: '1' }) })).toBe(null);
  });
});
