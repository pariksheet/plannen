import { describe, it, expect, vi } from 'vitest';

import { runMigrateTier2 } from '../lib/migrate-tier2.mjs';

function makeFakeSupabaseCli(scripted = []) {
  const calls = [];
  const responses = [...scripted];
  const cli = vi.fn((args, opts) => {
    calls.push({ args, opts });
    return responses.shift() ?? { status: 0, stdout: '', stderr: '' };
  });
  return { cli, calls };
}

describe('runMigrateTier2', () => {
  it('throws when projectRef is missing', async () => {
    const sb = makeFakeSupabaseCli();
    await expect(
      runMigrateTier2({ projectRef: '', env: {}, supabaseCli: sb.cli, log: () => {} }),
    ).rejects.toThrow(/SUPABASE_PROJECT_REF required/i);
    expect(sb.cli).not.toHaveBeenCalled();
  });

  it('happy path: links to projectRef, then pushes via --linked (no --project-ref on push)', async () => {
    const sb = makeFakeSupabaseCli();
    await runMigrateTier2({
      projectRef: 'abcabcabcabcabcabcab',
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_test', SUPABASE_DB_PASSWORD: 'pw' },
      supabaseCli: sb.cli,
      log: () => {},
    });

    expect(sb.calls).toHaveLength(2);
    expect(sb.calls[0].args).toEqual(['link', '--project-ref', 'abcabcabcabcabcabcab']);
    expect(sb.calls[1].args).toEqual(['db', 'push', '--linked']);
    // The `db push` invocation must NOT carry a --project-ref flag — the current
    // Supabase CLI rejects that flag for `db push` and the bug we're fixing was
    // exactly that mismatch.
    expect(sb.calls[1].args).not.toContain('--project-ref');

    // Access token + db password are forwarded so non-interactive push works.
    expect(sb.calls[0].opts.env.SUPABASE_ACCESS_TOKEN).toBe('sbp_test');
    expect(sb.calls[1].opts.env.SUPABASE_DB_PASSWORD).toBe('pw');
  });

  it('propagates --include-all when SUPABASE_DB_PUSH_INCLUDE_ALL=1', async () => {
    const sb = makeFakeSupabaseCli();
    await runMigrateTier2({
      projectRef: 'abcabcabcabcabcabcab',
      env: { SUPABASE_DB_PUSH_INCLUDE_ALL: '1' },
      supabaseCli: sb.cli,
      log: () => {},
    });

    const pushCall = sb.calls.find((c) => c.args[0] === 'db' && c.args[1] === 'push');
    expect(pushCall.args).toEqual(['db', 'push', '--linked', '--include-all']);
  });

  it('surfaces supabase link failure cleanly and never calls push', async () => {
    const sb = makeFakeSupabaseCli([
      { status: 1, stdout: '', stderr: 'invalid project ref' },
    ]);
    await expect(
      runMigrateTier2({
        projectRef: 'abcabcabcabcabcabcab',
        env: {},
        supabaseCli: sb.cli,
        log: () => {},
      }),
    ).rejects.toThrow(/supabase link.*invalid project ref/i);

    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0].args[0]).toBe('link');
  });

  it('surfaces supabase db push failure cleanly', async () => {
    const sb = makeFakeSupabaseCli([
      { status: 0, stdout: 'linked', stderr: '' },
      { status: 1, stdout: '', stderr: 'remote rejected: missing privilege' },
    ]);
    await expect(
      runMigrateTier2({
        projectRef: 'abcabcabcabcabcabcab',
        env: {},
        supabaseCli: sb.cli,
        log: () => {},
      }),
    ).rejects.toThrow(/supabase db push.*missing privilege/i);

    expect(sb.calls).toHaveLength(2);
  });
});
