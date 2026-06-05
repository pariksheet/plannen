import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokePromote, loadCloudProfile, parseVercelUrl } from '../commands/promote.mjs';

let tmpHome;
beforeEach(() => { tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-promote-')); });
afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

/**
 * Synthetic-mode env with both staging + prod cloud creds. Mirrors what the
 * promote-prod.yml workflow will pass through GitHub Secrets.
 */
function syntheticEnv() {
  return {
    HOME: tmpHome,
    PLANNEN_PROFILE_FROM_ENV: '1',
    PLANNEN_TIER: '2',
    STAGING_SUPABASE_PROJECT_REF: 'aaaaaaaaaaaaaaaaaaaa',
    STAGING_SUPABASE_ACCESS_TOKEN: 'sbp_staging',
    STAGING_SUPABASE_DB_PASSWORD: 'stg-pw',
    STAGING_VERCEL_TOKEN: 'vc_staging',
    STAGING_VERCEL_PROJECT_ID: 'prj_staging',
    STAGING_VERCEL_ORG_ID: 'team_x',
    PROD_SUPABASE_PROJECT_REF: 'bbbbbbbbbbbbbbbbbbbb',
    PROD_SUPABASE_ACCESS_TOKEN: 'sbp_prod',
    PROD_SUPABASE_DB_PASSWORD: 'prd-pw',
    PROD_VERCEL_TOKEN: 'vc_prod',
    PROD_VERCEL_PROJECT_ID: 'prj_prod',
    PROD_VERCEL_ORG_ID: 'team_x',
  };
}

/**
 * Fake fetch for the Management API SQL endpoint. `migrationsByRef` maps
 * project ref → array of version strings.
 */
function makeFakeFetch(migrationsByRef) {
  return vi.fn(async (url, init) => {
    const m = url.match(/\/projects\/([^/]+)\/database\/query/);
    if (!m) throw new Error(`unexpected fetch URL: ${url}`);
    const ref = m[1];
    const versions = migrationsByRef[ref] ?? [];
    const rows = versions.map((v) => ({ version: v }));
    return {
      ok: true,
      status: 200,
      json: async () => rows,
      text: async () => JSON.stringify(rows),
    };
  });
}

function makeFakeSupabaseCli(scripted = []) {
  const calls = [];
  const responses = [...scripted];
  const cli = vi.fn((args, opts) => {
    calls.push({ args, opts });
    const r = responses.shift();
    return r ?? { status: 0, stdout: '', stderr: '' };
  });
  return { cli, calls };
}

function makeFakeVercelCli(scripted = []) {
  const calls = [];
  const responses = [...scripted];
  const cli = vi.fn((args, opts) => {
    calls.push({ args, opts });
    const r = responses.shift();
    return r ?? { status: 0, stdout: 'https://plannen-prod.vercel.app\n', stderr: '' };
  });
  return { cli, calls };
}

describe('parseVercelUrl', () => {
  it('extracts the first https URL ending in .vercel.app from stdout', () => {
    expect(parseVercelUrl('Deploying...\nhttps://plannen-prod-abc123.vercel.app\nDone.')).toBe(
      'https://plannen-prod-abc123.vercel.app',
    );
  });
  it('returns null when no URL is present', () => {
    expect(parseVercelUrl('no url here')).toBeNull();
    expect(parseVercelUrl('')).toBeNull();
    expect(parseVercelUrl(undefined)).toBeNull();
  });
});

describe('loadCloudProfile (synthetic mode)', () => {
  it('strips STAGING_/PROD_ prefix and exposes bare keys', () => {
    const env = syntheticEnv();
    const staging = loadCloudProfile('staging', env);
    expect(staging.SUPABASE_PROJECT_REF).toBe('aaaaaaaaaaaaaaaaaaaa');
    expect(staging.SUPABASE_ACCESS_TOKEN).toBe('sbp_staging');
    expect(staging.PLANNEN_PROFILE).toBe('staging');
    const prod = loadCloudProfile('prod', env);
    expect(prod.SUPABASE_PROJECT_REF).toBe('bbbbbbbbbbbbbbbbbbbb');
    expect(prod.VERCEL_TOKEN).toBe('vc_prod');
  });
});

describe('plannen promote', () => {
  it('happy path: parity passes, db push + functions + vercel run, returns prod URL', async () => {
    const env = syntheticEnv();
    const fetch = makeFakeFetch({
      aaaaaaaaaaaaaaaaaaaa: ['00000000000000', '20260518000000'],
      bbbbbbbbbbbbbbbbbbbb: ['00000000000000'],
    });
    const sb = makeFakeSupabaseCli();
    const vc = makeFakeVercelCli([
      { status: 0, stdout: 'https://plannen-prod-xyz.vercel.app\n', stderr: '' },
    ]);
    const cloudDeployRun = vi.fn(async (ctx) => ({ ...ctx, deployedFunctions: ['mcp', 'analyse-source'] }));

    const result = await invokePromote(
      {},
      {
        env, fetch,
        supabaseCli: sb.cli, vercelCli: vc.cli,
        cloudDeployRun,
        ensureBin: () => {},
        log: () => {},
      },
    );

    expect(result.deploymentUrl).toBe('https://plannen-prod-xyz.vercel.app');
    expect(result.appliedToProd).toEqual(['20260518000000']);
    expect(result.staging).toBe('staging');
    expect(result.prod).toBe('prod');

    // supabase link + db push, both with PROD's access token
    const linkCall = sb.calls.find((c) => c.args[0] === 'link');
    expect(linkCall.args).toEqual(['link', '--project-ref', 'bbbbbbbbbbbbbbbbbbbb']);
    expect(linkCall.opts.env.SUPABASE_ACCESS_TOKEN).toBe('sbp_prod');
    expect(linkCall.opts.env.SUPABASE_DB_PASSWORD).toBe('prd-pw');
    const pushCall = sb.calls.find((c) => c.args[0] === 'db' && c.args[1] === 'push');
    expect(pushCall.args).toEqual(['db', 'push', '--linked']);

    // cloudDeploy.run called with prod ref
    expect(cloudDeployRun).toHaveBeenCalledOnce();
    expect(cloudDeployRun.mock.calls[0][0].projectRef).toBe('bbbbbbbbbbbbbbbbbbbb');

    // vercel --prod with prod token and project env
    expect(vc.calls[0].args).toEqual(['--prod', '--yes', '--token', 'vc_prod']);
    expect(vc.calls[0].opts.env.VERCEL_PROJECT_ID).toBe('prj_prod');
    expect(vc.calls[0].opts.env.VERCEL_ORG_ID).toBe('team_x');
  });

  it('refuses when prod has migrations staging does not', async () => {
    const env = syntheticEnv();
    const fetch = makeFakeFetch({
      aaaaaaaaaaaaaaaaaaaa: ['00000000000000'],
      bbbbbbbbbbbbbbbbbbbb: ['00000000000000', '99999999999999'],
    });
    const cloudDeployRun = vi.fn();
    const sb = makeFakeSupabaseCli();
    const vc = makeFakeVercelCli();

    await expect(
      invokePromote({}, {
        env, fetch,
        supabaseCli: sb.cli, vercelCli: vc.cli, cloudDeployRun,
        ensureBin: () => {}, log: () => {},
      }),
    ).rejects.toThrow(/prod is ahead of staging by 1 migration/);

    // None of the side-effect tools should have run after the refusal.
    expect(sb.cli).not.toHaveBeenCalled();
    expect(vc.cli).not.toHaveBeenCalled();
    expect(cloudDeployRun).not.toHaveBeenCalled();
  });

  it('warns (does not refuse) when staging is ahead — that is the normal case', async () => {
    const env = syntheticEnv();
    const fetch = makeFakeFetch({
      aaaaaaaaaaaaaaaaaaaa: ['00000000000000', '20260519000000', '20260520000000'],
      bbbbbbbbbbbbbbbbbbbb: ['00000000000000'],
    });
    const logs = [];
    const cloudDeployRun = vi.fn(async (ctx) => ({ ...ctx, deployedFunctions: [] }));
    const sb = makeFakeSupabaseCli();
    const vc = makeFakeVercelCli();

    const result = await invokePromote({}, {
      env, fetch,
      supabaseCli: sb.cli, vercelCli: vc.cli, cloudDeployRun,
      ensureBin: () => {},
      log: (s) => logs.push(s),
    });

    expect(result.appliedToProd).toEqual(['20260519000000', '20260520000000']);
    expect(logs.some((l) => /2 migration\(s\) will apply to prod/.test(l))).toBe(true);
  });

  it('surfaces supabase db push failure cleanly', async () => {
    const env = syntheticEnv();
    const fetch = makeFakeFetch({
      aaaaaaaaaaaaaaaaaaaa: ['00000000000000'],
      bbbbbbbbbbbbbbbbbbbb: ['00000000000000'],
    });
    const sb = makeFakeSupabaseCli([
      { status: 0, stdout: 'linked', stderr: '' },                                  // link
      { status: 1, stdout: '', stderr: 'remote rejected: missing privilege' },      // db push
    ]);
    const cloudDeployRun = vi.fn();
    const vc = makeFakeVercelCli();

    await expect(
      invokePromote({}, {
        env, fetch,
        supabaseCli: sb.cli, vercelCli: vc.cli, cloudDeployRun,
        ensureBin: () => {}, log: () => {},
      }),
    ).rejects.toThrow(/supabase db push.*missing privilege/i);

    expect(cloudDeployRun).not.toHaveBeenCalled();
    expect(vc.cli).not.toHaveBeenCalled();
  });

  it('refuses when prod profile is missing VERCEL_TOKEN', async () => {
    const env = syntheticEnv();
    delete env.PROD_VERCEL_TOKEN;
    const fetch = makeFakeFetch({});
    await expect(
      invokePromote({}, {
        env, fetch,
        supabaseCli: makeFakeSupabaseCli().cli,
        vercelCli: makeFakeVercelCli().cli,
        cloudDeployRun: vi.fn(),
        ensureBin: () => {}, log: () => {},
      }),
    ).rejects.toThrow(/prod profile missing VERCEL_TOKEN/);
  });

  it('treats "table does not exist" parity errors as empty migration list', async () => {
    // First-time provision: schema_migrations table not created yet on prod.
    const env = syntheticEnv();
    const fetch = vi.fn(async (url) => {
      const m = url.match(/\/projects\/([^/]+)\/database\/query/);
      const ref = m[1];
      if (ref === 'bbbbbbbbbbbbbbbbbbbb') {
        return {
          ok: false,
          status: 400,
          text: async () => 'relation "supabase_migrations.schema_migrations" does not exist',
        };
      }
      return {
        ok: true, status: 200,
        json: async () => [{ version: '00000000000000' }],
      };
    });
    const sb = makeFakeSupabaseCli();
    const vc = makeFakeVercelCli();
    const cloudDeployRun = vi.fn(async (ctx) => ({ ...ctx, deployedFunctions: [] }));

    const result = await invokePromote({}, {
      env, fetch,
      supabaseCli: sb.cli, vercelCli: vc.cli, cloudDeployRun,
      ensureBin: () => {}, log: () => {},
    });
    expect(result.prodApplied).toEqual([]);
    expect(result.appliedToProd).toEqual(['00000000000000']);
  });
});
