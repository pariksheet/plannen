import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, lstatSync, readlinkSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeInit } from '../commands/init.mjs';
import { profileExists, readManifest, getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
let tmpRepo;
const env = () => ({ HOME: tmpHome });

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-init-'));
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'plannen-init-repo-'));
  // Provide a minimal .env.example so the orchestrator's mergeEnv step has
  // something to copy. (Real repo ships one; tests fabricate.)
  writeFileSync(path.join(tmpRepo, '.env.example'), 'PLANNEN_USER_EMAIL=\nPLANNEN_TIER=\n');
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
});

/**
 * Default no-op dep-injection harness for invokeInit. Each test layers its
 * own overrides on top. Without explicit overrides, every subprocess succeeds
 * (exit 0) and prompts auto-accept (Y).
 */
function makeCtx(overrides = {}) {
  const calls = { spawn: [], sspawn: [], prompt: [] };
  const ctx = {
    env: env(),
    repoRoot: tmpRepo,
    spawn: vi.fn(async (cmd, args, opts) => {
      calls.spawn.push({ cmd, args, opts });
      return 0;
    }),
    spawnSync: vi.fn((cmd, args, opts) => {
      calls.sspawn.push({ cmd, args, opts });
      // `which X` probes — say YES for the binaries init needs in pre-flight
      // (node, supabase, docker), NO for optional ones (claude).
      if (cmd === 'which' && args && args.length === 1) {
        const bin = args[0];
        if (bin === 'node' || bin === 'supabase' || bin === 'docker') {
          return { status: 0, stdout: `/usr/bin/${bin}\n`, stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }
      // Version probes return a high number so versionGe passes.
      if (args && args.includes('--version')) {
        return { status: 0, stdout: '99.0.0\n', stderr: '' };
      }
      // docker info — succeed.
      if (cmd === 'docker' && args && args[0] === 'info') {
        return { status: 0, stdout: '', stderr: '' };
      }
      // git config user.email — return empty (so the email cascade falls
      // through to --email or existing .env).
      if (cmd === 'git' && args && args[0] === 'config') {
        return { status: 0, stdout: '\n', stderr: '' };
      }
      // node -e pg shims (readUserCount, insertAuthUser, supabase-mgmt probe).
      // The first prints a count (we want >0 so seed restore is skipped); the
      // second prints a uuid.
      if (cmd === 'node' && args && args[0] === '-e') {
        const src = args[1] ?? '';
        if (/INSERT INTO auth\.users/.test(src)) {
          return { status: 0, stdout: '00000000-0000-0000-0000-000000000001', stderr: '' };
        }
        if (/SELECT count/.test(src)) {
          return { status: 0, stdout: '1', stderr: '' };
        }
      }
      // node scripts/lib/auth-user.mjs <email>
      if (cmd === 'node' && args && args[0] && String(args[0]).includes('auth-user.mjs')) {
        return { status: 0, stdout: '11111111-1111-1111-1111-111111111111\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }),
    spawnBg: vi.fn(() => ({ pid: 12345 })),
    prompt: vi.fn(async (q, opts) => {
      calls.prompt.push({ q, opts });
      return ''; // default-accept
    }),
    waitForPort: vi.fn(async () => true),
    log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, dim: () => {} },
    ensureProfile: undefined, // use real one
    ...overrides,
  };
  return { ctx, calls };
}

describe('invokeInit', () => {
  it('rejects an unknown mode', async () => {
    const { ctx } = makeCtx();
    await expect(invokeInit({ mode: 'banana' }, ctx)).rejects.toThrow(/mode/i);
  });

  it('creates the default profile on first run and symlinks <repo>/.env to it', async () => {
    const { ctx } = makeCtx();
    await invokeInit({ mode: 'local_pg', email: 'me@example.com', 'non-interactive': true }, ctx);
    expect(profileExists('default', env())).toBe(true);
    const repoEnv = path.join(tmpRepo, '.env');
    expect(lstatSync(repoEnv).isSymbolicLink()).toBe(true);
    expect(readlinkSync(repoEnv)).toBe(getProfileEnvPath('default', env()));
  });

  it('creates a named profile when --profile is passed', async () => {
    const { ctx } = makeCtx();
    await invokeInit({ mode: 'cloud_sb', profile: 'staging', email: 'me@x', 'non-interactive': true }, ctx);
    expect(readManifest('staging', env()).mode).toBe('cloud_sb');
  });

  it('derives --mode from the active profile manifest when omitted', async () => {
    // Seed the situation from the user report: profile already exists with a
    // declared mode + is active. `plannen init` (no args) should not error
    // out demanding --mode; it should pick local_pg up from the manifest.
    const { invokeProfileCreate } = await import('../commands/profile/create.mjs');
    const { setActive } = await import('../lib/profiles.mjs');
    await invokeProfileCreate({ name: 'sb_prod', mode: 'local_pg' }, { env: env(), now: () => '2026-05-19T00:00:00Z' });
    setActive('sb_prod', env());

    const { ctx } = makeCtx();
    const code = await invokeInit({ email: 'me@x', 'non-interactive': true }, ctx);
    expect(code ?? 0).toBe(0);
    // Init operated on sb_prod, not on a freshly-created 'default'.
    expect(profileExists('sb_prod', env())).toBe(true);
    expect(profileExists('default', env())).toBe(false);
  });

  it('still errors when --mode is omitted AND no profile exists', async () => {
    const { ctx } = makeCtx();
    await expect(invokeInit({ email: 'me@x', 'non-interactive': true }, ctx))
      .rejects.toThrow(/--mode is required/i);
  });

  it.each([
    ['local_pg', '0'],
    ['tier0', '0'],
  ])('mode=%s writes PLANNEN_TIER=%s into the env file', async (mode, expectedTier) => {
    const { ctx } = makeCtx();
    await invokeInit({ mode, email: 'me@x', 'non-interactive': true }, ctx);
    const envFile = readFileSync(path.join(tmpRepo, '.env'), 'utf8');
    expect(envFile).toContain(`PLANNEN_TIER=${expectedTier}`);
  });

  it('requires --email or existing env when --non-interactive', async () => {
    const { ctx } = makeCtx();
    // No --email, no existing .env email, --non-interactive → return 1.
    const code = await invokeInit({ mode: 'local_pg', 'non-interactive': true }, ctx);
    expect(code).toBe(1);
  });

  it('honours an existing PLANNEN_USER_EMAIL in .env over a missing --email', async () => {
    // Pre-seed the profile env so ensureProfile reuses it, and pre-create the
    // .env symlink that points there.
    writeFileSync(path.join(tmpRepo, '.env'), 'PLANNEN_USER_EMAIL=existing@example.com\n');
    const { ctx } = makeCtx();
    const code = await invokeInit({ mode: 'local_pg', 'non-interactive': true }, ctx);
    expect(code).toBe(0);
    // After init, .env (now a symlink to the profile env) has the email.
    const envText = readFileSync(path.join(tmpRepo, '.env'), 'utf8');
    expect(envText).toContain('PLANNEN_USER_EMAIL=existing@example.com');
  });

  it('rejects 0→2 jump with a clear error', async () => {
    // Pre-create .env with PLANNEN_TIER=0 so the orchestrator sees old_tier=0.
    writeFileSync(path.join(tmpRepo, '.env'), 'PLANNEN_TIER=0\nPLANNEN_USER_EMAIL=me@x\n');
    const errs = [];
    const { ctx } = makeCtx({
      log: { step: () => {}, ok: () => {}, warn: () => {}, err: (s) => errs.push(s), dim: () => {} },
    });
    const code = await invokeInit({ mode: 'cloud_sb', email: 'me@x', 'non-interactive': true }, ctx);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/Tier 0 → Tier 2 is not a direct path/);
  });

  it('Tier 0 happy path writes the expected env keys', async () => {
    const { ctx } = makeCtx();
    const code = await invokeInit({ mode: 'local_pg', email: 'me@example.com', 'non-interactive': true }, ctx);
    expect(code).toBe(0);
    const envText = readFileSync(path.join(tmpRepo, '.env'), 'utf8');
    expect(envText).toContain('PLANNEN_TIER=0');
    expect(envText).toContain('PLANNEN_USER_EMAIL=me@example.com');
    expect(envText).toContain('DATABASE_URL=postgres://plannen:plannen@127.0.0.1:54322/plannen');
    expect(envText).toContain('BACKEND_URL=http://127.0.0.1:54323');
    expect(envText).toContain('VITE_PLANNEN_TIER=0');
  });

  it('honours --tier-style --non-interactive without --start-dev: dev server not started', async () => {
    const { ctx, calls } = makeCtx();
    await invokeInit({ mode: 'local_pg', email: 'me@x', 'non-interactive': true }, ctx);
    const devCalls = calls.spawn.filter((c) => (c.args ?? []).some((a) => String(a).includes('dev-start.sh')));
    expect(devCalls.length).toBe(0);
  });

  it('starts the dev server when --start-dev is passed with --non-interactive', async () => {
    const { ctx, calls } = makeCtx();
    await invokeInit({ mode: 'local_pg', email: 'me@x', 'non-interactive': true, 'start-dev': true }, ctx);
    const devCalls = calls.spawn.filter((c) => (c.args ?? []).some((a) => String(a).includes('dev-start.sh')));
    expect(devCalls.length).toBe(1);
  });

  it('propagates non-zero exit from a sub-step', async () => {
    const { ctx } = makeCtx({
      // Fail npm install (the first spawned subprocess).
      spawn: vi.fn(async (cmd, args) => {
        if (cmd === 'npm' && args[0] === 'install') return 7;
        return 0;
      }),
    });
    const code = await invokeInit({ mode: 'local_pg', email: 'me@x', 'non-interactive': true }, ctx);
    expect(code).toBe(7);
  });

  it('skips plugin install in --non-interactive without --install-plugin', async () => {
    const { ctx, calls } = makeCtx();
    await invokeInit({ mode: 'local_pg', email: 'me@x', 'non-interactive': true }, ctx);
    const pluginCalls = calls.spawn.filter((c) => c.cmd === 'claude');
    expect(pluginCalls.length).toBe(0);
  });

  it('2→1 reverse path restores .env.tier1.bak when present', async () => {
    // Set the scene: we're "currently" on Tier 2.
    writeFileSync(path.join(tmpRepo, '.env'), 'PLANNEN_TIER=2\nPLANNEN_USER_EMAIL=me@x\n');
    writeFileSync(path.join(tmpRepo, '.env.tier1.bak'), 'PLANNEN_TIER=1\nPLANNEN_USER_EMAIL=me@x\nFROM_BAK=yes\n');
    const { ctx } = makeCtx();
    const code = await invokeInit({ mode: 'local_sb', email: 'me@x', 'non-interactive': true }, ctx);
    expect(code).toBe(0);
    // After restore + step 7 envSet, the file still has the restored value
    // before being overwritten with PLANNEN_TIER=1.
    const envText = readFileSync(path.join(tmpRepo, '.env'), 'utf8');
    expect(envText).toContain('FROM_BAK=yes');
    expect(envText).toContain('PLANNEN_TIER=1');
  });

  it('passes the composed env (with PLANNEN_PROFILE/TIER) through to subprocess calls', async () => {
    const { ctx, calls } = makeCtx();
    await invokeInit({ mode: 'cloud_sb', profile: 'staging', email: 'me@x', 'non-interactive': true, 'skip-vercel': true, 'project-ref': 'aaaaaaaaaaaaaaaaaaaa', 'cloud-db-url': 'postgresql://x' }, ctx);
    // The migrate-tier1-to-tier2.mjs is the central subprocess that gets the
    // composed env. With tierChange not set (fresh tier 2), most of those
    // env vars route through that single call. Just verify *some* spawn saw
    // PLANNEN_PROFILE=staging.
    const sawProfile = calls.spawn.some((c) => c.opts?.env?.PLANNEN_PROFILE === 'staging');
    expect(sawProfile).toBe(true);
    expect(readManifest('staging', env()).mode).toBe('cloud_sb');
  });
});
