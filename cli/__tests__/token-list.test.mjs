import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-list-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_USER_EMAIL=me@example.com\nDATABASE_URL=postgres://x\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

function makeCtx(rows) {
  const out = [];
  return {
    env: { HOME: tmpHome },
    poolFactory: () => ({
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u1' }], rowCount: 1 };
          if (sql.includes('FROM plannen.user_tokens')) return { rows, rowCount: rows.length };
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
      end: async () => {},
    }),
    log: { info: (s) => out.push(s) },
    _captured: out,
  };
}

describe('plannen token list', () => {
  it('prints rows in tabular form, no plaintext or hash', async () => {
    const { runTokenList } = await import('../commands/token/list.mjs');
    const ctx = makeCtx([
      { id: 't1', label: 'MacBook', prefix: 'plnnn_aaa', created_at: '2026-05-01', last_used_at: '2026-05-19', expires_at: null },
      { id: 't2', label: 'VPS', prefix: 'plnnn_bbb', created_at: '2026-04-01', last_used_at: null, expires_at: '2027-01-01' },
    ]);
    await runTokenList({}, ctx);
    const out = ctx._captured.join('\n');
    expect(out).toMatch(/MacBook/);
    expect(out).toMatch(/VPS/);
    expect(out).toMatch(/plnnn_aaa/);
    expect(out).not.toMatch(/token_hash/);
    expect(out).not.toMatch(/plaintext/);
  });

  it('prints helpful message when no tokens', async () => {
    const { runTokenList } = await import('../commands/token/list.mjs');
    const ctx = makeCtx([]);
    await runTokenList({}, ctx);
    expect(ctx._captured.join('\n')).toMatch(/no tokens/i);
  });
});
