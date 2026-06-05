import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-rot-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_TIER=2\nPLANNEN_USER_EMAIL=me@x\nDATABASE_URL=postgres://x\nMCP_BEARER_TOKEN=plnnn_old' + 'a'.repeat(40) + '\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

describe('plannen token rotate', () => {
  it('revokes the current PAT, mints a new one, writes profile env', async () => {
    const { runTokenRotate } = await import('../commands/token/rotate.mjs');
    const queries = [];
    const ctx = {
      env: { HOME: tmpHome },
      poolFactory: () => ({
        connect: async () => ({
          query: async (sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u1' }], rowCount: 1 };
            if (sql.includes('SELECT id FROM plannen.user_tokens')) return { rows: [{ id: 'tok-old' }], rowCount: 1 };
            if (sql.includes('DELETE')) return { rows: [], rowCount: 1 };
            if (sql.includes('INSERT')) return { rows: [{ id: 'tok-new' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        }),
        end: async () => {},
      }),
      rewritePluginJson: vi.fn(),
      log: { info: vi.fn() },
    };

    await runTokenRotate({}, ctx);

    expect(queries.some((q) => q.sql.includes('DELETE'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('INSERT'))).toBe(true);
    const envText = readFileSync(path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'), 'utf8');
    expect(envText).toMatch(/^MCP_BEARER_TOKEN=plnnn_/m);
    expect(envText).not.toMatch(/plnnn_old/);
    expect(ctx.rewritePluginJson).toHaveBeenCalledOnce();
  });

  it('errors if MCP_BEARER_TOKEN not set in profile', async () => {
    writeFileSync(
      path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
      'PLANNEN_USER_EMAIL=me@x\nDATABASE_URL=postgres://x\n',
    );
    const { runTokenRotate } = await import('../commands/token/rotate.mjs');
    await expect(runTokenRotate({}, { env: { HOME: tmpHome } })).rejects.toThrow(/MCP_BEARER_TOKEN/);
  });
});
