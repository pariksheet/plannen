import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { readManifest, readEnvFile, getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-create-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

describe('profile create', () => {
  it('writes manifest with offset 0 and seeds env file with tier + ports', async () => {
    await invokeProfileCreate({ name: 'default', mode: 'local_pg' }, { env: env(), now });
    const m = readManifest('default', env());
    expect(m).toEqual({ name: 'default', mode: 'local_pg', port_offset: 0, created_at: '2026-05-18T00:00:00Z' });
    const e = readEnvFile(getProfileEnvPath('default', env()));
    expect(e.PLANNEN_TIER).toBe('0');
    expect(e.PLANNEN_PG_PORT).toBe('54322');
    expect(e.PLANNEN_BACKEND_PORT).toBe('54323');
    expect(e.PLANNEN_WEB_PORT).toBe('4321');
    expect(e.PLANNEN_PROFILE).toBeUndefined();
  });

  it('chmods env file to 0600', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    const mode = statSync(getProfileEnvPath('p', env())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('second profile gets port_offset 100 and shifted ports', async () => {
    await invokeProfileCreate({ name: 'a', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'b', mode: 'local_pg' }, { env: env(), now });
    expect(readManifest('b', env()).port_offset).toBe(100);
    expect(readEnvFile(getProfileEnvPath('b', env())).PLANNEN_PG_PORT).toBe('54422');
  });

  it.each([
    ['local_sb', '1'],
    ['cloud_sb', '2'],
  ])('mode=%s maps to tier=%s', async (mode, tier) => {
    await invokeProfileCreate({ name: 'p', mode }, { env: env(), now });
    expect(readEnvFile(getProfileEnvPath('p', env())).PLANNEN_TIER).toBe(tier);
  });

  it('refuses an unknown mode', async () => {
    await expect(invokeProfileCreate({ name: 'p', mode: 'banana' }, { env: env(), now })).rejects.toThrow(/mode/i);
  });

  it('refuses to overwrite existing without --force', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    await expect(invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now })).rejects.toThrow(/already exists/);
  });

  it('overwrites when --force is set', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb', force: true }, { env: env(), now });
    expect(readManifest('p', env()).mode).toBe('cloud_sb');
  });

  it('rejects when --mode is missing', async () => {
    await expect(invokeProfileCreate({ name: 'p' }, { env: env(), now })).rejects.toThrow(/mode/i);
  });

  it('rejects when name is missing', async () => {
    await expect(invokeProfileCreate({ mode: 'local_pg' }, { env: env(), now })).rejects.toThrow(/name/i);
  });
});
