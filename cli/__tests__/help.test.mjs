import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BIN = path.resolve(path.dirname(__filename), '..', '..', 'bin', 'plannen.mjs');

function run(args) {
  return spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
}

describe('plannen CLI top-level', () => {
  it('--help lists all four headline verbs', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    for (const verb of ['init', 'up', 'down', 'status']) {
      expect(out).toContain(verb);
    }
  });

  it('--version prints a semver-looking string', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('unknown verb exits non-zero', () => {
    const r = run(['not-a-real-verb']);
    expect(r.status).not.toBe(0);
  });
});
