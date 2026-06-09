import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeProfileUse } from '../commands/profile/use.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import {
  setActive,
  resolveActiveProfile,
  getActivePointerPath,
  getProfileEnvPath,
} from '../lib/profiles.mjs';

let tmpHome;
let tmpRepo;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-use-'));
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'plannen-use-repo-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe('profile use', () => {
  it('flips ~/.plannen/active and writes .env symlink', async () => {
    await invokeProfileCreate({ name: 'default', mode: 'local_pg' }, { env: env(), now });
    const code = await invokeProfileUse(
      { name: 'default' },
      { env: env(), repoRoot: tmpRepo, isProfileRunning: () => false },
    );
    expect(code).toBe(0);
    expect(readFileSync(getActivePointerPath(env()), 'utf8').trim()).toBe('default');
    expect(resolveActiveProfile(env())).toBe('default');
    const repoEnv = path.join(tmpRepo, '.env');
    expect(lstatSync(repoEnv).isSymbolicLink()).toBe(true);
    expect(readlinkSync(repoEnv)).toBe(getProfileEnvPath('default', env()));
  });

  it('refuses if the previous profile is still running', async () => {
    await invokeProfileCreate({ name: 'a', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'b', mode: 'local_pg' }, { env: env(), now });
    setActive('a', env());
    await expect(
      invokeProfileUse(
        { name: 'b' },
        { env: env(), repoRoot: tmpRepo, isProfileRunning: () => true },
      ),
    ).rejects.toThrow(/down/i);
  });

  it('allows switching if no services running', async () => {
    await invokeProfileCreate({ name: 'a', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'b', mode: 'local_pg' }, { env: env(), now });
    setActive('a', env());
    const code = await invokeProfileUse(
      { name: 'b' },
      { env: env(), repoRoot: tmpRepo, isProfileRunning: () => false },
    );
    expect(code).toBe(0);
    expect(resolveActiveProfile(env())).toBe('b');
  });

  it('rejects unknown profile', async () => {
    await expect(
      invokeProfileUse(
        { name: 'ghost' },
        { env: env(), repoRoot: tmpRepo, isProfileRunning: () => false },
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects when name is missing', async () => {
    await expect(
      invokeProfileUse({}, { env: env(), repoRoot: tmpRepo, isProfileRunning: () => false }),
    ).rejects.toThrow(/name/i);
  });
});

describe('profile use — per-profile running probe (#7)', () => {
  it("blocks the switch when the previous profile's own backend pid is alive", async () => {
    const { getProfileDir } = await import('../lib/profiles.mjs');
    await invokeProfileCreate({ name: 'a', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'b', mode: 'local_pg' }, { env: env(), now });
    setActive('a', env());
    // Simulate profile a's backend running: its per-profile pid file holds a
    // live pid (ours). A fake pidCommand returns the backend marker so the
    // identity check confirms it as a Plannen backend process.  This exercises
    // the real composed-env probe path (Fix A) while keeping Fix B deterministic
    // — the marker identity check is tested independently in lifecycle-identity.test.mjs.
    const aDir = getProfileDir('a', env());
    mkdirSync(aDir, { recursive: true });
    writeFileSync(path.join(aDir, 'backend.pid'), String(process.pid));
    const fakePidCommand = (_pid) => 'node /path/to/plannen/backend/dist/index.js';
    await expect(
      invokeProfileUse({ name: 'b' }, { env: env(), repoRoot: tmpRepo, _pidCommand: fakePidCommand }),
    ).rejects.toThrow(/still running/);
  });

  it("allows the switch when the previous profile's pid files are dead or absent", async () => {
    await invokeProfileCreate({ name: 'a', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'b', mode: 'local_pg' }, { env: env(), now });
    setActive('a', env());
    const code = await invokeProfileUse({ name: 'b' }, { env: env(), repoRoot: tmpRepo });
    expect(code).toBe(0);
    expect(resolveActiveProfile(env())).toBe('b');
  });
});
