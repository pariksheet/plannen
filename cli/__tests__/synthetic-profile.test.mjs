import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  composeEnv,
  isSyntheticMode,
  profileExists,
  readManifest,
  resolveActiveProfile,
} from '../lib/profiles.mjs';

let tmpHome;

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-synth-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

describe('synthetic profile mode (PLANNEN_PROFILE_FROM_ENV=1)', () => {
  it('isSyntheticMode toggles on the env flag', () => {
    expect(isSyntheticMode({})).toBe(false);
    expect(isSyntheticMode({ PLANNEN_PROFILE_FROM_ENV: '0' })).toBe(false);
    expect(isSyntheticMode({ PLANNEN_PROFILE_FROM_ENV: '1' })).toBe(true);
  });

  it('profileExists is always true under synthetic mode (no ~/.plannen lookup)', () => {
    const env = { HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1' };
    expect(profileExists('staging', env)).toBe(true);
    expect(profileExists('totally-made-up', env)).toBe(true);
  });

  it('readManifest returns a synthesized manifest derived from PLANNEN_TIER', () => {
    const env = { HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1', PLANNEN_TIER: '2' };
    const m = readManifest('prod', env);
    expect(m).toEqual({
      name: 'prod',
      mode: 'cloud_sb',
      port_offset: 0,
      created_at: null,
      synthetic: true,
    });
  });

  it('readManifest defaults to local_pg when PLANNEN_TIER is unset', () => {
    const env = { HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1' };
    expect(readManifest('staging', env).mode).toBe('local_pg');
  });

  it('resolveActiveProfile returns env.PLANNEN_PROFILE when set, else "synthetic"', () => {
    expect(resolveActiveProfile({ HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1', PLANNEN_PROFILE: 'staging' })).toBe('staging');
    expect(resolveActiveProfile({ HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1' })).toBe('synthetic');
  });

  it('composeEnv skips the profile-env-file read and does not inject PLANNEN_PROFILE_DIR', () => {
    const env = {
      HOME: tmpHome,
      PLANNEN_PROFILE_FROM_ENV: '1',
      PLANNEN_TIER: '2',
      SUPABASE_URL: 'https://staging.example',
    };
    const composed = composeEnv('staging', { OVERRIDE_KEY: 'win' }, env);
    expect(composed.PLANNEN_TIER).toBe('2');
    expect(composed.SUPABASE_URL).toBe('https://staging.example');
    expect(composed.PLANNEN_PROFILE).toBe('staging');
    expect(composed.OVERRIDE_KEY).toBe('win');
    expect(composed.PLANNEN_PROFILE_DIR).toBeUndefined();
  });

  it('overrides still beat env values in synthetic mode', () => {
    const env = { HOME: tmpHome, PLANNEN_PROFILE_FROM_ENV: '1', PLANNEN_TIER: '1' };
    const composed = composeEnv('any', { PLANNEN_TIER: '2' }, env);
    expect(composed.PLANNEN_TIER).toBe('2');
  });
});

describe('non-synthetic mode still reads files (regression check)', () => {
  it('profileExists returns false for a missing profile when not synthetic', () => {
    expect(profileExists('ghost', { HOME: tmpHome })).toBe(false);
  });

  it('readManifest throws for a missing profile when not synthetic', () => {
    expect(() => readManifest('ghost', { HOME: tmpHome })).toThrow(/ghost/);
  });
});
