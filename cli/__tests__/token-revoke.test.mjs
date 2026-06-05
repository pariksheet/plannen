import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-rev-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_USER_EMAIL=me@example.com\nDATABASE_URL=postgres://x\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

// matchedRows controls the prefix-lookup result; deleteRowCount controls revokeToken's DELETE.
function makeCtx({ matchedRows = [{ id: 't1-full-uuid' }], deleteRowCount = 1 } = {}) {
  return {
    env: { HOME: tmpHome },
    poolFactory: () => ({
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u1' }], rowCount: 1 };
          if (sql.includes('SELECT id FROM plannen.user_tokens')) return { rows: matchedRows, rowCount: matchedRows.length };
          if (sql.includes('DELETE')) return { rows: [], rowCount: deleteRowCount };
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
      end: async () => {},
    }),
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('plannen token revoke', () => {
  it('returns ok when row deleted', async () => {
    const { runTokenRevoke } = await import('../commands/token/revoke.mjs');
    const r = await runTokenRevoke({ id: 't1' }, makeCtx());
    expect(r).toBe(true);
  });

  it('throws when id prefix matches nothing', async () => {
    const { runTokenRevoke } = await import('../commands/token/revoke.mjs');
    await expect(runTokenRevoke({ id: 'tX' }, makeCtx({ matchedRows: [] }))).rejects.toThrow(/not found/i);
  });

  it('throws when id prefix is ambiguous', async () => {
    const { runTokenRevoke } = await import('../commands/token/revoke.mjs');
    await expect(
      runTokenRevoke({ id: 'aa' }, makeCtx({ matchedRows: [{ id: 'aaaa-1' }, { id: 'aaaa-2' }] })),
    ).rejects.toThrow(/ambiguous/i);
  });

  it('requires id', async () => {
    const { runTokenRevoke } = await import('../commands/token/revoke.mjs');
    await expect(runTokenRevoke({}, makeCtx())).rejects.toThrow(/id/i);
  });
});
