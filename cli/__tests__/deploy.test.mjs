import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeDeploy } from '../commands/deploy.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { setActive } from '../lib/profiles.mjs';

let tmpHome;
let tmpRepo;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-05-18T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-deploy-'));
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'plannen-deploy-repo-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
});

/**
 * Drives the dep-injected vercel CLI. Mirrors what scripts/lib/vercel-deploy.mjs
 * expects: an array of {args, options} → returns the next stub response, in
 * insertion order. Unmatched calls return a default success.
 */
function makeFakeCli(scripted = []) {
  const calls = [];
  const responses = [...scripted];
  const cli = vi.fn((args, options) => {
    calls.push({ args, options });
    const r = responses.shift();
    if (r) return r;
    return { status: 0, stdout: '', stderr: '' };
  });
  return { cli, calls };
}

function defaultScript() {
  // (vercelLoggedIn) `vercel whoami` → ok
  // (vercelLink, only if .vercel/ missing) `vercel link --yes` → ok
  // (vercelEnvRm × N) per-key remove → ok (idempotent on miss)
  // (vercelEnvAdd × N) per-key add → ok
  // (vercelDeploy) `vercel --prod` → returns URL
  // (vercelInspect) `vercel inspect <url>` → returns aliases listing
  // (vercelEnvRm wireAuth lookup) — no-op extras tolerated
  return [];
}

function writeEnv(extra = {}) {
  const baseEnv = {
    PLANNEN_TIER: '2',
    VITE_SUPABASE_URL: 'https://abc.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'eyJ.anonkey',
    VITE_PLANNEN_TIER: '2',
    ...extra,
  };
  const text = Object.entries(baseEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(path.join(tmpRepo, '.env'), text);
}

describe('plannen deploy', () => {
  it('refuses when there is no active profile', async () => {
    writeEnv();
    await expect(
      invokeDeploy({}, { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli: makeFakeCli().cli }),
    ).rejects.toThrow(/no active profile/i);
  });

  it('refuses when the profile is not tier 2 (cloud_sb)', async () => {
    writeEnv();
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    setActive('p', env());
    await expect(
      invokeDeploy({}, { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli: makeFakeCli().cli }),
    ).rejects.toThrow(/tier 2/i);
  });

  it('proceeds when the manifest is stale local_pg but the env file is tier 2', async () => {
    // Simulates a long-lived `default` profile whose manifest was set at
    // local_pg creation time, then bootstrap tier-switched the env file to
    // tier 2 without rewriting profile.json.
    writeEnv();
    await invokeProfileCreate({ name: 'p', mode: 'local_pg' }, { env: env(), now });
    setActive('p', env());
    // Overwrite the profile env file to reflect tier 2.
    writeFileSync(
      path.join(tmpHome, '.plannen', 'profiles', 'p', 'env'),
      'PLANNEN_TIER=2\nVITE_SUPABASE_URL=https://abc.supabase.co\nVITE_SUPABASE_ANON_KEY=eyJ.anon\n',
    );
    mkdirSync(path.join(tmpRepo, '.vercel'));
    const { cli } = makeFakeCli();
    cli.mockImplementation(() => ({ status: 0, stdout: 'https://x.vercel.app\n', stderr: '' }));
    const result = await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: () => {} },
    );
    expect(result.profile).toBe('p');
  });

  it('refuses when the named profile does not exist', async () => {
    writeEnv();
    await expect(
      invokeDeploy(
        { profile: 'ghost' },
        { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli: makeFakeCli().cli },
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses when vercel CLI is missing', async () => {
    writeEnv();
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    await expect(
      invokeDeploy(
        {},
        {
          env: env(),
          repoRoot: tmpRepo,
          ensureBin: (bin) => { throw new Error(`${bin} CLI not found`); },
          cli: makeFakeCli().cli,
        },
      ),
    ).rejects.toThrow(/vercel CLI not found/);
  });

  it('refuses to auto-link when .vercel/ is missing and --vercel-project is not given (issue #24 fix)', async () => {
    writeEnv();
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    await expect(
      invokeDeploy(
        {},
        { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli: makeFakeCli().cli },
      ),
    ).rejects.toThrow(/Refusing to auto-link/i);
  });

  it('links to the named Vercel project when --vercel-project is given', async () => {
    writeEnv();
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    const { cli, calls } = makeFakeCli();
    await invokeDeploy(
      { 'vercel-project': 'plannen-prod' },
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: () => {} },
    );
    const linkCall = calls.find((c) => c.args[0] === 'link');
    expect(linkCall).toBeDefined();
    expect(linkCall.args).toEqual(['link', '--yes', '--project', 'plannen-prod']);
  });

  // Guards against a re-introduction of `require('node:child_process')` in this
  // ES module — the default linker fallback used to call `require(...)` which
  // throws `ReferenceError: require is not defined` whenever a caller ran
  // deploy from a worktree without injecting ctx.cli.
  it('default linker fallback does not use require() (ESM regression)', async () => {
    const src = readFileSync(
      path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'commands', 'deploy.mjs'),
      'utf8',
    );
    expect(src).not.toMatch(/require\(['"]node:child_process['"]\)/);
  });

  it('skips link when .vercel/ already exists', async () => {
    writeEnv();
    mkdirSync(path.join(tmpRepo, '.vercel'));
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    const { cli, calls } = makeFakeCli();
    await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: () => {} },
    );
    expect(calls.find((c) => c.args[0] === 'link')).toBeUndefined();
  });

  it('falls back to the profile env file when <repo>/.env is missing (fresh worktree case)', async () => {
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    // Seed the profile env with the VITE_* keys directly — no <repo>/.env file.
    writeFileSync(
      path.join(tmpHome, '.plannen', 'profiles', 'p', 'env'),
      'PLANNEN_TIER=2\nVITE_SUPABASE_URL=https://abc.supabase.co\nVITE_SUPABASE_ANON_KEY=eyJ.anon\n',
    );
    mkdirSync(path.join(tmpRepo, '.vercel'));
    const { cli } = makeFakeCli();
    cli.mockImplementation((args) => {
      const a = args.join(' ');
      if (a.startsWith('whoami')) return { status: 0, stdout: 'me', stderr: '' };
      if (a.startsWith('env rm')) return { status: 0, stdout: '', stderr: '' };
      if (a.startsWith('env add')) return { status: 0, stdout: '', stderr: '' };
      if (a === '--prod') return { status: 0, stdout: 'https://x.vercel.app\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const logs = [];
    const result = await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: (s) => logs.push(s) },
    );
    expect(result.profile).toBe('p');
    expect(logs.join('\n')).toMatch(/profile env.*no \.env in this worktree/i);
  });

  it('warns (does not block) when local supabase/migrations are not yet applied on the remote project', async () => {
    writeEnv();
    mkdirSync(path.join(tmpRepo, '.vercel'));
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());

    // Profile env needs the Supabase Management API creds for the warning step
    // to engage. Without them the step skips silently — covered by the other
    // tests, which never trip this code path.
    const profileEnvPath = path.join(tmpHome, '.plannen', 'profiles', 'p', 'env');
    writeFileSync(
      profileEnvPath,
      readFileSync(profileEnvPath, 'utf8') +
        '\nSUPABASE_ACCESS_TOKEN=sbp_test\nSUPABASE_PROJECT_REF=abcdefghijklmnopqrst\n',
    );

    // Local migrations: three files. The fake API will report only the first
    // is applied — so v2 + v3 are the pending pair the warning must name.
    mkdirSync(path.join(tmpRepo, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(path.join(tmpRepo, 'supabase', 'migrations', '20260101000000_v1.sql'), '-- v1');
    writeFileSync(path.join(tmpRepo, 'supabase', 'migrations', '20260102000000_v2.sql'), '-- v2');
    writeFileSync(path.join(tmpRepo, 'supabase', 'migrations', '20260103000000_v3.sql'), '-- v3');

    const fetchCalls = [];
    const fakeFetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => [{ version: '20260101000000_v1' }],
        text: async () => JSON.stringify([{ version: '20260101000000_v1' }]),
      };
    });

    const { cli } = makeFakeCli();
    cli.mockImplementation(() => ({ status: 0, stdout: 'https://x.vercel.app\n', stderr: '' }));
    const logs = [];
    const result = await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: (s) => logs.push(s), fetch: fakeFetch },
    );

    expect(fetchCalls).toHaveLength(1);
    const joined = logs.join('\n');
    expect(joined).toMatch(/2 pending migration\(s\)/i);
    expect(joined).toMatch(/20260102000000_v2/);
    expect(joined).toMatch(/20260103000000_v3/);
    // Deploy MUST still proceed — this is a warn-not-block guardrail.
    expect(result.profile).toBe('p');
    expect(cli).toHaveBeenCalled();
  });

  it('does not warn when all local migrations are already applied on the remote', async () => {
    writeEnv();
    mkdirSync(path.join(tmpRepo, '.vercel'));
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());

    const profileEnvPath = path.join(tmpHome, '.plannen', 'profiles', 'p', 'env');
    writeFileSync(
      profileEnvPath,
      readFileSync(profileEnvPath, 'utf8') +
        '\nSUPABASE_ACCESS_TOKEN=sbp_test\nSUPABASE_PROJECT_REF=abcdefghijklmnopqrst\n',
    );

    mkdirSync(path.join(tmpRepo, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(path.join(tmpRepo, 'supabase', 'migrations', '20260101000000_v1.sql'), '-- v1');

    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ version: '20260101000000_v1' }],
      text: async () => '',
    }));

    const { cli } = makeFakeCli();
    cli.mockImplementation(() => ({ status: 0, stdout: 'https://x.vercel.app\n', stderr: '' }));
    const logs = [];
    await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: (s) => logs.push(s), fetch: fakeFetch },
    );

    expect(logs.join('\n')).not.toMatch(/pending migration/i);
  });

  it('skips the migration check silently when SUPABASE_ACCESS_TOKEN is not on the profile', async () => {
    // No creds → no warning attempt → no fetch call. The user might be deploying
    // from a fresh worktree before `plannen cloud provision` has filled these in.
    writeEnv();
    mkdirSync(path.join(tmpRepo, '.vercel'));
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());

    mkdirSync(path.join(tmpRepo, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(path.join(tmpRepo, 'supabase', 'migrations', '20260101000000_v1.sql'), '-- v1');

    const fakeFetch = vi.fn();
    const { cli } = makeFakeCli();
    cli.mockImplementation(() => ({ status: 0, stdout: 'https://x.vercel.app\n', stderr: '' }));
    await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: () => {}, fetch: fakeFetch },
    );

    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('persists primaryUrl back to .env as PLANNEN_WEB_URL when resolvable', async () => {
    writeEnv();
    mkdirSync(path.join(tmpRepo, '.vercel'));
    await invokeProfileCreate({ name: 'p', mode: 'cloud_sb' }, { env: env(), now });
    setActive('p', env());
    // The cli is called many times; we orchestrate the deploy + inspect paths:
    // whoami(ok), envRm×N (ok), envAdd×N (ok via stdin), deploy (returns URL),
    // inspect (returns one stable alias).
    const deployUrl = 'https://plannen-abcd-xy.vercel.app';
    const stableAlias = 'https://plannen.vercel.app';
    const { cli } = makeFakeCli();
    cli.mockImplementation((args) => {
      const a = args.join(' ');
      if (a.startsWith('whoami')) return { status: 0, stdout: 'me@example', stderr: '' };
      if (a.startsWith('link')) return { status: 0, stdout: '', stderr: '' };
      if (a.startsWith('env rm')) return { status: 0, stdout: '', stderr: '' };
      if (a.startsWith('env add')) return { status: 0, stdout: '', stderr: '' };
      if (a === '--prod' || a === '') return { status: 0, stdout: deployUrl + '\n', stderr: '' };
      if (a.startsWith('inspect')) {
        return {
          status: 0,
          stdout: `Aliases\n  ${deployUrl}\n  ${stableAlias}\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await invokeDeploy(
      {},
      { env: env(), repoRoot: tmpRepo, ensureBin: () => {}, cli, log: () => {} },
    );
    expect(result.deploymentUrl).toBe(deployUrl);
    const finalEnv = readFileSync(path.join(tmpRepo, '.env'), 'utf8');
    expect(finalEnv).toMatch(/PLANNEN_WEB_URL=https:\/\/plannen\.vercel\.app/);
  });
});
