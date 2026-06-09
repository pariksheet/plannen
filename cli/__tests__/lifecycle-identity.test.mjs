/**
 * Tests for Fix A (per-profile pid paths in composeEnv) and
 * Fix B (identity-checked liveness in pidFileAlive / isBackendRunning / isPgRunning).
 *
 * Fix A — composeEnv must always produce per-profile PLANNEN_PG_PID /
 *   PLANNEN_BACKEND_PID, even for old profiles whose env file lacks those keys.
 *
 * Fix B — isPgRunning / isBackendRunning must require the process's command
 *   line to contain a known Plannen marker, so OS PID-reuse can't cause a
 *   false positive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  composeEnv,
  getProfileDir,
  getProfileEnvPath,
  writeManifest,
  writeEnvFile,
} from '../lib/profiles.mjs';

import {
  isPgRunning,
  isBackendRunning,
  getPgPidFile,
  getBackendPidFile,
} from '../lib/lifecycle.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

let tmpHome;

function makeEnv(extra = {}) {
  return { HOME: tmpHome, ...extra };
}

function createProfile(name, envVars = {}) {
  const env = makeEnv();
  writeManifest(name, { name, mode: 'local_pg', port_offset: 0, created_at: 'x' }, env);
  writeEnvFile(getProfileEnvPath(name, env), {
    PLANNEN_TIER: '0',
    PLANNEN_PG_PORT: '54322',
    ...envVars,
  });
  return env;
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-lifecycle-id-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Fix A: per-profile pid paths in composeEnv ───────────────────────────────

describe('Fix A — composeEnv per-profile pid paths', () => {
  it('sets PLANNEN_PG_PID inside the profile dir when the profile env file lacks it', () => {
    // Simulate an old profile that has no PLANNEN_PG_PID in its env file.
    const env = createProfile('legacy');
    const composed = composeEnv('legacy', {}, env);
    const expectedDir = getProfileDir('legacy', env);
    expect(composed.PLANNEN_PG_PID).toBe(path.join(expectedDir, 'pg.pid'));
  });

  it('sets PLANNEN_BACKEND_PID inside the profile dir when the profile env file lacks it', () => {
    const env = createProfile('legacy');
    const composed = composeEnv('legacy', {}, env);
    const expectedDir = getProfileDir('legacy', env);
    expect(composed.PLANNEN_BACKEND_PID).toBe(path.join(expectedDir, 'backend.pid'));
  });

  it('respects an explicit PLANNEN_PG_PID in the profile env file (profileEnv wins)', () => {
    const customPid = path.join(tmpHome, 'custom', 'my-pg.pid');
    const env = createProfile('custom-pg', { PLANNEN_PG_PID: customPid });
    const composed = composeEnv('custom-pg', {}, env);
    expect(composed.PLANNEN_PG_PID).toBe(customPid);
  });

  it('respects an explicit PLANNEN_BACKEND_PID in the profile env file (profileEnv wins)', () => {
    const customPid = path.join(tmpHome, 'custom', 'my-backend.pid');
    const env = createProfile('custom-be', { PLANNEN_BACKEND_PID: customPid });
    const composed = composeEnv('custom-be', {}, env);
    expect(composed.PLANNEN_BACKEND_PID).toBe(customPid);
  });

  it('respects an explicit PLANNEN_PG_PID in the override (caller wins over profile env)', () => {
    const overridePid = path.join(tmpHome, 'override', 'pg.pid');
    const env = createProfile('override-pg');
    const composed = composeEnv('override-pg', { PLANNEN_PG_PID: overridePid }, env);
    expect(composed.PLANNEN_PG_PID).toBe(overridePid);
  });

  it('respects an explicit PLANNEN_BACKEND_PID in the override (caller wins over profile env)', () => {
    const overridePid = path.join(tmpHome, 'override', 'backend.pid');
    const env = createProfile('override-be');
    const composed = composeEnv('override-be', { PLANNEN_BACKEND_PID: overridePid }, env);
    expect(composed.PLANNEN_BACKEND_PID).toBe(overridePid);
  });

  it('per-profile pid paths differ between two profiles', () => {
    const env = createProfile('alice');
    createProfile('bob'); // uses same tmpHome env
    const composedA = composeEnv('alice', {}, env);
    const composedB = composeEnv('bob', {}, env);
    expect(composedA.PLANNEN_PG_PID).not.toBe(composedB.PLANNEN_PG_PID);
    expect(composedA.PLANNEN_BACKEND_PID).not.toBe(composedB.PLANNEN_BACKEND_PID);
    expect(composedA.PLANNEN_PG_PID).toContain('alice');
    expect(composedB.PLANNEN_PG_PID).toContain('bob');
  });

  it('respects PLANNEN_PG_PID already in baseEnv when profile env is silent (baseEnv wins over default)', () => {
    const env = createProfile('legacy');
    const baseEnvWithPid = { ...env, PLANNEN_PG_PID: path.join(tmpHome, 'base-pg.pid') };
    const composed = composeEnv('legacy', {}, baseEnvWithPid);
    // Profile env has no PLANNEN_PG_PID, so baseEnv should win over the default.
    expect(composed.PLANNEN_PG_PID).toBe(path.join(tmpHome, 'base-pg.pid'));
  });
});

// ─── Fix B: identity-checked liveness ────────────────────────────────────────

describe('Fix B — isPgRunning rejects PID-reuse false positives', () => {
  /**
   * isPgRunning / isBackendRunning accept an optional `_pidCommand` injection
   * parameter so tests can substitute their own ps resolver without shelling out.
   *
   * This test verifies the injected-runner path: when the PID is "alive"
   * (process.kill(pid,0) would succeed — we use process.pid for that), but the
   * command line does NOT contain the Plannen marker, the function must return false.
   */

  it('returns false when pid is live but command lacks the pg marker (PID reuse)', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    // Use our own PID — it's definitely alive.
    writeFileSync(getPgPidFile(env), String(process.pid));
    // Inject a fake ps runner that returns a command without the pg marker.
    const fakePsRunner = (_pid) => '/usr/bin/SomeOtherProcess --flag';
    expect(isPgRunning(env, fakePsRunner)).toBe(false);
  });

  it('returns true when pid is live AND command includes the pg marker', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    writeFileSync(getPgPidFile(env), String(process.pid));
    // Inject a fake ps runner that returns a command containing the pg marker.
    const fakePsRunner = (_pid) => 'node /path/to/scripts/lib/plannen-pg.mjs start';
    expect(isPgRunning(env, fakePsRunner)).toBe(true);
  });

  it('returns false when pidfile is absent (no change from before)', () => {
    const env = makeEnv();
    const fakePsRunner = (_pid) => 'node /path/plannen-pg.mjs start';
    expect(isPgRunning(env, fakePsRunner)).toBe(false);
  });

  it('returns false when PID is dead regardless of marker', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    // Use a PID that cannot exist.
    writeFileSync(getPgPidFile(env), '2147483646');
    const fakePsRunner = (_pid) => 'node plannen-pg.mjs start';
    expect(isPgRunning(env, fakePsRunner)).toBe(false);
  });

  it('returns false (safe) when ps runner throws / returns empty string', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    writeFileSync(getPgPidFile(env), String(process.pid));
    // Simulate ps failing to return anything useful.
    const failingPsRunner = (_pid) => '';
    expect(isPgRunning(env, failingPsRunner)).toBe(false);
  });
});

describe('Fix B — isBackendRunning rejects PID-reuse false positives', () => {
  it('returns false when pid is live but command lacks the backend marker (PID reuse)', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    writeFileSync(getBackendPidFile(env), String(process.pid));
    const fakePsRunner = (_pid) => '/Applications/GoogleDrive.app/Contents/MacOS/GoogleDrive';
    expect(isBackendRunning(env, fakePsRunner)).toBe(false);
  });

  it('returns true when pid is live AND command includes the backend marker', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    writeFileSync(getBackendPidFile(env), String(process.pid));
    const fakePsRunner = (_pid) => 'node /home/user/plannen/backend/dist/index.js';
    expect(isBackendRunning(env, fakePsRunner)).toBe(true);
  });

  it('returns false when ps runner returns empty string (safe fallback)', () => {
    const env = makeEnv();
    mkdirSync(path.join(tmpHome, '.plannen'), { recursive: true });
    writeFileSync(getBackendPidFile(env), String(process.pid));
    const failingPsRunner = (_pid) => '';
    expect(isBackendRunning(env, failingPsRunner)).toBe(false);
  });

  it('returns false when pidfile is absent', () => {
    const env = makeEnv();
    const fakePsRunner = (_pid) => 'node backend/dist/index.js';
    expect(isBackendRunning(env, fakePsRunner)).toBe(false);
  });
});
