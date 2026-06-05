// scripts/lib/userTokens.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mintToken,
  listTokens,
  revokeToken,
  resolveTokenToUserId,
  PLNNN_PREFIX,
} from './userTokens.mjs';

function makeClient(handler) {
  return { query: vi.fn(async (sql, params = []) => handler(sql, params)) };
}

describe('mintToken (node)', () => {
  it('returns plnnn_-prefixed plaintext', async () => {
    const client = makeClient(() => ({ rows: [{ id: 't1' }], rowCount: 1 }));
    const r = await mintToken(client, 'u1', 'MacBook');
    expect(r.plaintext.startsWith(PLNNN_PREFIX)).toBe(true);
    expect(r.id).toBe('t1');
  });

  it('stores sha-256 of plaintext', async () => {
    let storedHash = null;
    const client = makeClient((sql, params) => {
      if (sql.includes('INSERT')) storedHash = params[2];
      return { rows: [{ id: 't1' }], rowCount: 1 };
    });
    const r = await mintToken(client, 'u1', 'MacBook');
    expect(storedHash).toEqual(createHash('sha256').update(r.plaintext).digest());
  });

  it('rejects empty label', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }));
    await expect(mintToken(client, 'u1', '')).rejects.toThrow(/label/i);
    await expect(mintToken(client, 'u1', '   ')).rejects.toThrow(/label/i);
  });
});

describe('listTokens / revokeToken (node)', () => {
  it('list returns rows without secrets', async () => {
    const client = makeClient((_sql, params) => {
      expect(params[0]).toBe('u1');
      return { rows: [{ id: 't1', label: 'a', prefix: 'plnnn_aaa', created_at: 'x', last_used_at: null, expires_at: null }], rowCount: 1 };
    });
    const rows = await listTokens(client, 'u1');
    expect(rows[0]).not.toHaveProperty('token_hash');
  });

  it('revoke true on rowCount > 0', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 1 }));
    expect(await revokeToken(client, 'u1', 't1')).toBe(true);
  });

  it('revoke false on rowCount = 0', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }));
    expect(await revokeToken(client, 'u1', 'tX')).toBe(false);
  });
});

describe('resolveTokenToUserId (node)', () => {
  it('returns user_id on valid token', async () => {
    const client = makeClient((sql) => {
      expect(sql).toMatch(/UPDATE plannen\.user_tokens/i);
      expect(sql).toMatch(/RETURNING user_id/i);
      return { rows: [{ user_id: 'u1' }], rowCount: 1 };
    });
    expect(await resolveTokenToUserId(client, 'plnnn_x')).toBe('u1');
  });

  it('returns null when no row', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }));
    expect(await resolveTokenToUserId(client, 'plnnn_x')).toBeNull();
  });
});
