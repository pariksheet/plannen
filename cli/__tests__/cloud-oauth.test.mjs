import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeOauthEnable, invokeOauthStatus } from '../commands/cloud/oauth.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-06-05T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-oauth-'));
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
  const calls = { updateOAuthServerConfig: [], getAuthConfig: [] };
  return {
    calls,
    mgmt: {
      readAccessToken: () => 'fake-token',
      updateOAuthServerConfig: async (token, ref, patch) => {
        calls.updateOAuthServerConfig.push({ token, ref, patch });
        return { changed: true, body: patch };
      },
      getAuthConfig: async (token, ref) => {
        calls.getAuthConfig.push({ token, ref });
        return {
          oauth_server_enabled: true,
          oauth_server_allow_dynamic_registration: true,
          oauth_server_authorization_path: '/oauth/consent',
        };
      },
      ...overrides,
    },
  };
}

describe('invokeOauthEnable', () => {
  it('refuses non-cloud_sb profiles', async () => {
    await withProfile('local', 'local_pg');
    await expect(
      invokeOauthEnable({ profile: 'local' }, { env: env(), supabaseMgmt: makeMgmt().mgmt }),
    ).rejects.toThrow(/cloud_sb required/);
  });

  it('refuses when the profile has no SUPABASE_PROJECT_REF', async () => {
    await withProfile('prod', 'cloud_sb');
    await expect(
      invokeOauthEnable({ profile: 'prod' }, { env: env(), supabaseMgmt: makeMgmt().mgmt }),
    ).rejects.toThrow(/SUPABASE_PROJECT_REF/);
  });

  it('patches the oauth server config and prints the connector URL', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'refxyz',
      PLANNEN_WEB_URL: 'https://plannen.example.app',
    });
    const { calls, mgmt } = makeMgmt();
    const lines = [];
    const result = await invokeOauthEnable(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: (s) => lines.push(s) },
    );
    expect(calls.updateOAuthServerConfig).toEqual([
      { token: 'fake-token', ref: 'refxyz', patch: { authorizationPath: '/oauth/consent' } },
    ]);
    expect(result.connectorUrl).toBe('https://refxyz.supabase.co/functions/v1/mcp');
    expect(lines.join('\n')).toContain('https://refxyz.supabase.co/functions/v1/mcp');
  });

  it('throws when no Supabase access token is available', async () => {
    await withProfile('prod', 'cloud_sb', { SUPABASE_PROJECT_REF: 'refxyz' });
    const { mgmt } = makeMgmt({ readAccessToken: () => null });
    await expect(
      invokeOauthEnable({ profile: 'prod' }, { env: env(), supabaseMgmt: mgmt }),
    ).rejects.toThrow(/access token/);
  });
});

describe('invokeOauthStatus', () => {
  it('reports the oauth_server_* fields', async () => {
    await withProfile('prod', 'cloud_sb', { SUPABASE_PROJECT_REF: 'refxyz' });
    const { calls, mgmt } = makeMgmt();
    const lines = [];
    const status = await invokeOauthStatus(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: (s) => lines.push(s) },
    );
    expect(calls.getAuthConfig).toEqual([{ token: 'fake-token', ref: 'refxyz' }]);
    expect(status.enabled).toBe(true);
    expect(status.authorizationPath).toBe('/oauth/consent');
    expect(status.connectorUrl).toBe('https://refxyz.supabase.co/functions/v1/mcp');
  });
});
