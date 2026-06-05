import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_TIER=2\nPLANNEN_USER_EMAIL=me@example.com\nDATABASE_URL=postgres://x\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

function makeCtx(overrides = {}) {
  return {
    env: { HOME: tmpHome, ...(overrides.env ?? {}) },
    poolFactory: overrides.poolFactory ?? (() => ({
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u-1' }], rowCount: 1 };
          if (sql.includes('INSERT INTO plannen.user_tokens')) return { rows: [{ id: 't-1' }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
      end: async () => {},
    })),
    rewritePluginJson: overrides.rewritePluginJson ?? vi.fn(),
    log: overrides.log ?? { info: vi.fn(), warn: vi.fn(), step: vi.fn(), ok: vi.fn() },
  };
}

describe('plannen token create', () => {
  it('mints, writes profile env, and rewrites plugin.json', async () => {
    const { runTokenCreate } = await import('../commands/token/create.mjs');
    const ctx = makeCtx();
    const out = await runTokenCreate({ label: 'MacBook' }, ctx);
    expect(out.plaintext.startsWith('plnnn_')).toBe(true);

    const envText = readFileSync(path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'), 'utf8');
    expect(envText).toMatch(/^MCP_BEARER_TOKEN=plnnn_/m);

    expect(ctx.rewritePluginJson).toHaveBeenCalledOnce();
  });

  it('--no-activate skips profile-env and plugin.json side effects', async () => {
    const { runTokenCreate } = await import('../commands/token/create.mjs');
    const ctx = makeCtx();
    await runTokenCreate({ label: 'MacBook', 'no-activate': true }, ctx);

    const envText = readFileSync(path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'), 'utf8');
    expect(envText).not.toMatch(/MCP_BEARER_TOKEN=plnnn_/);
    expect(ctx.rewritePluginJson).not.toHaveBeenCalled();
  });

  it('errors when active profile has no PLANNEN_USER_EMAIL', async () => {
    const { runTokenCreate } = await import('../commands/token/create.mjs');
    writeFileSync(
      path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
      'PLANNEN_TIER=2\nDATABASE_URL=postgres://x\n',
    );
    const ctx = makeCtx();
    await expect(runTokenCreate({ label: 'a' }, ctx)).rejects.toThrow(/PLANNEN_USER_EMAIL/);
  });

  it('errors when user email not found in DB', async () => {
    const { runTokenCreate } = await import('../commands/token/create.mjs');
    const ctx = makeCtx({
      poolFactory: () => ({
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: 0 }),
          release: () => {},
        }),
        end: async () => {},
      }),
    });
    await expect(runTokenCreate({ label: 'a' }, ctx)).rejects.toThrow(/No Plannen user/);
  });

  it('errors when label is empty', async () => {
    const { runTokenCreate } = await import('../commands/token/create.mjs');
    await expect(runTokenCreate({ label: '' }, makeCtx())).rejects.toThrow(/label/i);
  });
});
