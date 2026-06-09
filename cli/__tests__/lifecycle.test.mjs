import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isPgRunning, getPgPidFile } from '../lib/lifecycle.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-lifecycle-'));
  mkdirSync(path.join(tmpHome, '.plannen'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('isPgRunning', () => {
  it('returns false when no PID file exists', () => {
    expect(isPgRunning(env())).toBe(false);
  });

  it('returns false when PID file exists but the PID is dead', () => {
    // PID 1 is init on POSIX — we definitely don't own it, so process.kill(1, 0)
    // throws EPERM. Pick a PID we can be sure is not alive instead: a very
    // large number that cannot have been allocated.
    writeFileSync(getPgPidFile(env()), '2147483646');
    expect(isPgRunning(env())).toBe(false);
  });

  it('returns false when PID file is empty / unparseable', () => {
    writeFileSync(getPgPidFile(env()), '   ');
    expect(isPgRunning(env())).toBe(false);
    writeFileSync(getPgPidFile(env()), 'not-a-number');
    expect(isPgRunning(env())).toBe(false);
  });

  it('returns true when PID file points at a live process with the pg marker', () => {
    // The test process itself is the easiest live PID to reference.
    // Inject a fake pidCommand so the test doesn't depend on the test process's
    // real command line (which will never contain 'plannen-pg.mjs').
    writeFileSync(getPgPidFile(env()), String(process.pid));
    const fakePsRunner = (_pid) => 'node /path/to/scripts/lib/plannen-pg.mjs start';
    expect(isPgRunning(env(), fakePsRunner)).toBe(true);
  });
});
