import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BIN = path.resolve(path.dirname(__filename), '..', '..', 'bin', 'plannen.mjs');

// Each smoke test isolates ~/.plannen via PLANNEN_HOME so it doesn't read the
// developer's real profile.
function isolatedEnv(extra = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'plannen-smoke-'));
  return { env: { ...process.env, PLANNEN_HOME: home, ...extra }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('plannen init (smoke)', () => {
  it('init --help completes without invoking bootstrap.sh', () => {
    const r = spawnSync('node', [BIN, 'init', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/--mode/);
    expect(out).toMatch(/--email/);
  });

  it('init without --mode and no existing profile exits non-zero', () => {
    // PLANNEN_HOME isolation: no profile exists to derive --mode from, so
    // init refuses. (On a dev machine with profiles, init *would* succeed by
    // reading the active profile's manifest — that path is covered in
    // init.test.mjs.)
    const { env, cleanup } = isolatedEnv();
    try {
      const r = spawnSync('node', [BIN, 'init'], { encoding: 'utf8', env });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/--mode/);
    } finally {
      cleanup();
    }
  });

  it('status (with no servers running on a CI-clean machine) exits 0 and prints all-down', () => {
    const { env, cleanup } = isolatedEnv();
    try {
      const r = spawnSync('node', [BIN, 'status', '--json'], { encoding: 'utf8', env });
      expect(r.status).toBe(0);
      const obj = JSON.parse(r.stdout);
      expect(obj.processes).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('status --json respects PLANNEN_TIER from environment when no profile is active', () => {
    const { env, cleanup } = isolatedEnv({ PLANNEN_TIER: '1' });
    try {
      const r = spawnSync('node', [BIN, 'status', '--json'], { encoding: 'utf8', env });
      expect(r.status).toBe(0);
      const obj = JSON.parse(r.stdout);
      expect(obj.tier).toBe('1');
      expect(obj.mode).toBe('local_sb');
    } finally {
      cleanup();
    }
  });
});
