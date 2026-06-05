import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  invokePasskeysEnable,
  deriveRpId,
  deriveOrigins,
} from '../commands/cloud/passkeys.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-21T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-passkeys-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function withProfile(name, mode, envFields = {}) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  if (Object.keys(envFields).length) {
    const envPath = getProfileEnvPath(name, env());
    const lines = Object.entries(envFields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    appendFileSync(envPath, lines);
  }
}

function makeMgmt(overrides = {}) {
  const calls = { updatePasskeyConfig: [], readAccessToken: 0 };
  return {
    calls,
    mgmt: {
      readAccessToken: () => { calls.readAccessToken++; return 'fake-token'; },
      updatePasskeyConfig: async (token, ref, patch) => {
        calls.updatePasskeyConfig.push({ token, ref, patch });
        return { changed: true, body: patch };
      },
      ...overrides,
    },
  };
}

describe('deriveRpId', () => {
  it('returns the bare host for https://plannen.app', () => {
    expect(deriveRpId('https://plannen.app')).toBe('plannen.app');
  });

  it('strips a leading www.', () => {
    expect(deriveRpId('https://www.plannen.app')).toBe('plannen.app');
  });

  it('keeps subdomains other than www.', () => {
    expect(deriveRpId('https://staging.plannen.app')).toBe('staging.plannen.app');
  });

  it('keeps localhost as RP ID', () => {
    expect(deriveRpId('http://localhost:4321')).toBe('localhost');
  });

  it('lowercases the host', () => {
    expect(deriveRpId('https://PLANNEN.APP/path')).toBe('plannen.app');
  });

  it('throws on garbage input', () => {
    expect(() => deriveRpId('not a url')).toThrow(/invalid URL/i);
  });
});

describe('deriveOrigins', () => {
  it('returns the canonical origin', () => {
    expect(deriveOrigins('https://plannen.app/path')).toEqual(['https://plannen.app']);
  });

  it('preserves explicit ports', () => {
    expect(deriveOrigins('http://localhost:4321')).toEqual(['http://localhost:4321']);
  });

  it('merges extras and strips trailing slashes', () => {
    expect(deriveOrigins('https://plannen.app', ['https://www.plannen.app/'])).toEqual([
      'https://plannen.app',
      'https://www.plannen.app',
    ]);
  });

  it('dedupes extras already in the canonical list', () => {
    expect(deriveOrigins('https://plannen.app', ['https://plannen.app'])).toEqual([
      'https://plannen.app',
    ]);
  });
});

describe('invokePasskeysEnable — input validation', () => {
  it('requires --profile', async () => {
    await expect(invokePasskeysEnable({}, { env: env() })).rejects.toThrow(/profile.*required/i);
  });

  it('refuses a non-existent profile', async () => {
    await expect(
      invokePasskeysEnable({ profile: 'ghost' }, { env: env() }),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses a profile whose mode is not cloud_sb', async () => {
    await withProfile('local-one', 'local_pg');
    const { mgmt } = makeMgmt();
    await expect(
      invokePasskeysEnable({ profile: 'local-one' }, { env: env(), supabaseMgmt: mgmt, log: () => {} }),
    ).rejects.toThrow(/cloud_sb required/);
  });

  it('refuses if the profile has no SUPABASE_PROJECT_REF', async () => {
    await withProfile('staging', 'cloud_sb', { PLANNEN_WEB_URL: 'https://plannen.app' });
    const { mgmt } = makeMgmt();
    await expect(
      invokePasskeysEnable({ profile: 'staging' }, { env: env(), supabaseMgmt: mgmt, log: () => {} }),
    ).rejects.toThrow(/SUPABASE_PROJECT_REF/);
  });

  it('refuses if neither PLANNEN_WEB_URL nor --rp-id is provided', async () => {
    await withProfile('staging', 'cloud_sb', { SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' });
    const { mgmt } = makeMgmt();
    await expect(
      invokePasskeysEnable({ profile: 'staging' }, { env: env(), supabaseMgmt: mgmt, log: () => {} }),
    ).rejects.toThrow(/no PLANNEN_WEB_URL/);
  });

  it('refuses if no Supabase access token is available', async () => {
    await withProfile('staging', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      PLANNEN_WEB_URL: 'https://plannen.app',
    });
    const { mgmt } = makeMgmt({ readAccessToken: () => null });
    await expect(
      invokePasskeysEnable({ profile: 'staging' }, { env: env(), supabaseMgmt: mgmt, log: () => {} }),
    ).rejects.toThrow(/access token/);
  });
});

describe('invokePasskeysEnable — happy path', () => {
  it('derives RP ID + origins from PLANNEN_WEB_URL and PATCHes the mgmt API', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      PLANNEN_WEB_URL: 'https://plannen.app',
    });
    const { mgmt, calls } = makeMgmt();
    const result = await invokePasskeysEnable(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: () => {} },
    );
    expect(result).toEqual({
      rpId: 'plannen.app',
      origins: ['https://plannen.app'],
      displayName: 'Plannen',
      changed: true,
    });
    expect(calls.updatePasskeyConfig).toHaveLength(1);
    const call = calls.updatePasskeyConfig[0];
    expect(call.ref).toBe('abcdefghijklmnopqrst');
    expect(call.patch.rpId).toBe('plannen.app');
    expect(call.patch.rpOrigins).toEqual(['https://plannen.app']);
    expect(call.patch.rpDisplayName).toBe('Plannen');
  });

  it('respects --rp-id and --origins overrides', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      PLANNEN_WEB_URL: 'https://plannen.app',
    });
    const { mgmt, calls } = makeMgmt();
    await invokePasskeysEnable(
      {
        profile: 'prod',
        rpId: 'custom-rp.example',
        origins: ['https://custom-rp.example', 'https://www.custom-rp.example'],
        displayName: 'Plannen Custom',
      },
      { env: env(), supabaseMgmt: mgmt, log: () => {} },
    );
    const call = calls.updatePasskeyConfig[0];
    expect(call.patch.rpId).toBe('custom-rp.example');
    expect(call.patch.rpOrigins).toEqual(['https://custom-rp.example', 'https://www.custom-rp.example']);
    expect(call.patch.rpDisplayName).toBe('Plannen Custom');
  });

  it('passes through the changed=false result from mgmt for idempotent re-runs', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      PLANNEN_WEB_URL: 'https://plannen.app',
    });
    const { mgmt } = makeMgmt({
      updatePasskeyConfig: async () => ({ changed: false }),
    });
    const result = await invokePasskeysEnable(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: () => {} },
    );
    expect(result.changed).toBe(false);
  });

  it('falls back to localhost RP ID when web URL is local', async () => {
    await withProfile('dev', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      PLANNEN_WEB_URL: 'http://localhost:4321',
    });
    const { mgmt, calls } = makeMgmt();
    await invokePasskeysEnable(
      { profile: 'dev' },
      { env: env(), supabaseMgmt: mgmt, log: () => {} },
    );
    const call = calls.updatePasskeyConfig[0];
    expect(call.patch.rpId).toBe('localhost');
    expect(call.patch.rpOrigins).toEqual(['http://localhost:4321']);
  });
});
