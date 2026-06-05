import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeProfileDelete } from '../commands/profile/delete.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive, getProfileDir, profileExists } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-delete-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

describe('profile delete', () => {
  it('removes the profile dir with --yes', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    expect(profileExists('p', env())).toBe(true);
    const code = await invokeProfileDelete({ name: 'p', yes: true }, { env: env() });
    expect(code).toBe(0);
    expect(existsSync(getProfileDir('p', env()))).toBe(false);
  });

  it('refuses without --yes', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    await expect(invokeProfileDelete({ name: 'p' }, { env: env() })).rejects.toThrow(/--yes/);
    expect(profileExists('p', env())).toBe(true);
  });

  it('refuses to delete the active profile', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    setActive('p', env());
    await expect(invokeProfileDelete({ name: 'p', yes: true }, { env: env() })).rejects.toThrow(/active/);
  });

  it('rejects unknown profile', async () => {
    await expect(invokeProfileDelete({ name: 'ghost', yes: true }, { env: env() })).rejects.toThrow(/does not exist/);
  });
});
