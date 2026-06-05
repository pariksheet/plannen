import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeProfileList } from '../commands/profile/list.mjs';
import { getProfileEnvPath, setActive, writeEnvFile, writeManifest } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });

function makeOut() {
  const chunks = [];
  return {
    out: { write: (s) => chunks.push(String(s)) },
    text: () => chunks.join(''),
  };
}

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-list-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

describe('profile list', () => {
  it('prints a no-profiles hint when empty', async () => {
    const { out, text } = makeOut();
    const code = await invokeProfileList({}, { env: env(), out });
    expect(code).toBe(0);
    expect(text()).toMatch(/no profiles/);
  });

  it('renders rows with active marker', async () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env());
    writeManifest('staging', { name: 'staging', mode: 'cloud_sb', port_offset: 100, created_at: 'b' }, env());
    setActive('staging', env());
    const { out, text } = makeOut();
    await invokeProfileList({}, { env: env(), out });
    const lines = text().trim().split('\n');
    expect(lines[0]).toMatch(/NAME.*MODE.*OFFSET.*ACTIVE/);
    expect(text()).toMatch(/default\s+local_pg\s+0\s+ /);
    expect(text()).toMatch(/staging\s+cloud_sb\s+100\s+\*/);
  });

  it('emits structured JSON with --json', async () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env());
    setActive('default', env());
    const { out, text } = makeOut();
    await invokeProfileList({ json: true }, { env: env(), out });
    const parsed = JSON.parse(text());
    expect(parsed.active).toBe('default');
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0].name).toBe('default');
    expect(parsed.profiles[0].drift).toBe(null);
  });

  it('flags drift when manifest.mode and env tier disagree', async () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env());
    writeEnvFile(getProfileEnvPath('default', env()), { PLANNEN_TIER: '2' });
    const { out, text } = makeOut();
    await invokeProfileList({}, { env: env(), out });
    expect(text()).toMatch(/drift: env tier=2 → expected mode=cloud_sb/);
    expect(text()).toMatch(/plannen profile sync-mode/);
  });

  it('includes drift details in --json output', async () => {
    writeManifest('default', { name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'a' }, env());
    writeEnvFile(getProfileEnvPath('default', env()), { PLANNEN_TIER: '2' });
    const { out, text } = makeOut();
    await invokeProfileList({ json: true }, { env: env(), out });
    const parsed = JSON.parse(text());
    expect(parsed.profiles[0].drift).toEqual({
      manifest_mode: 'local_pg',
      env_tier: '2',
      expected_mode: 'cloud_sb',
    });
  });
});
