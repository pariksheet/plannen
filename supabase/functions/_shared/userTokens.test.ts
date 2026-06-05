// supabase/functions/_shared/userTokens.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  mintToken,
  listTokens,
  revokeToken,
  resolveTokenToUserId,
  PLNNN_PREFIX,
} from './userTokens.ts'

type Row = Record<string, unknown>
function makeClient(handler: (sql: string, params: unknown[]) => { rows: Row[]; rowCount?: number }) {
  return { query: vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params)) } as any
}

describe('mintToken', () => {
  it('returns a plnnn_-prefixed plaintext token', async () => {
    const client = makeClient(() => ({ rows: [{ id: 't1' }], rowCount: 1 }))
    const r = await mintToken(client, 'u1', 'MacBook')
    expect(r.plaintext.startsWith(PLNNN_PREFIX)).toBe(true)
    expect(r.plaintext.length).toBeGreaterThanOrEqual(48)
    expect(r.id).toBe('t1')
  })

  it('stores the sha-256 of the plaintext', async () => {
    let storedHash: Buffer | null = null
    const client = makeClient((sql, params) => {
      if (sql.includes('INSERT')) storedHash = params[2] as Buffer
      return { rows: [{ id: 't1' }], rowCount: 1 }
    })
    const r = await mintToken(client, 'u1', 'MacBook')
    const expected = createHash('sha256').update(r.plaintext).digest()
    expect(storedHash).toEqual(expected)
  })

  it('stores the first 12 chars as prefix', async () => {
    let storedPrefix = ''
    const client = makeClient((sql, params) => {
      if (sql.includes('INSERT')) storedPrefix = params[3] as string
      return { rows: [{ id: 't1' }], rowCount: 1 }
    })
    const r = await mintToken(client, 'u1', 'MacBook')
    expect(storedPrefix).toBe(r.plaintext.slice(0, 12))
    expect(r.prefix).toBe(storedPrefix)
  })

  it('produces distinct tokens on repeated mints', async () => {
    const client = makeClient(() => ({ rows: [{ id: 't' + Math.random() }], rowCount: 1 }))
    const a = await mintToken(client, 'u1', 'a')
    const b = await mintToken(client, 'u1', 'a')
    expect(a.plaintext).not.toBe(b.plaintext)
  })

  it('rejects empty label', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }))
    await expect(mintToken(client, 'u1', '')).rejects.toThrow(/label/i)
    await expect(mintToken(client, 'u1', '   ')).rejects.toThrow(/label/i)
  })

  it('passes expires_at through to INSERT', async () => {
    let storedExpiry: unknown = null
    const client = makeClient((sql, params) => {
      if (sql.includes('INSERT')) storedExpiry = params[4]
      return { rows: [{ id: 't1' }], rowCount: 1 }
    })
    const expiry = '2027-01-01T00:00:00Z'
    await mintToken(client, 'u1', 'lbl', expiry)
    expect(storedExpiry).toBe(expiry)
  })
})

describe('listTokens', () => {
  it('returns caller-scoped rows without plaintext or hash', async () => {
    const client = makeClient((sql, params) => {
      expect(params[0]).toBe('u1')
      return {
        rows: [
          { id: 't1', label: 'a', prefix: 'plnnn_aaa', created_at: '2026-01-01', last_used_at: null, expires_at: null },
        ],
        rowCount: 1,
      }
    })
    const rows = await listTokens(client, 'u1')
    expect(rows[0]).not.toHaveProperty('token_hash')
    expect(rows[0]).not.toHaveProperty('plaintext')
    expect(rows[0].label).toBe('a')
  })
})

describe('revokeToken', () => {
  it('deletes on (user_id, id) match', async () => {
    const client = makeClient((sql, params) => {
      expect(sql).toMatch(/DELETE/i)
      expect(params).toEqual(['u1', 't1'])
      return { rows: [], rowCount: 1 }
    })
    expect(await revokeToken(client, 'u1', 't1')).toBe(true)
  })

  it('returns false when nothing matched', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }))
    expect(await revokeToken(client, 'u1', 'tX')).toBe(false)
  })
})

describe('resolveTokenToUserId', () => {
  it('returns user_id for a valid token and updates last_used_at', async () => {
    const client = makeClient((sql, params) => {
      expect(sql).toMatch(/UPDATE plannen\.user_tokens/i)
      expect(sql).toMatch(/SET last_used_at/i)
      expect(sql).toMatch(/RETURNING user_id/i)
      expect(params[0]).toBeInstanceOf(Buffer)
      return { rows: [{ user_id: 'u1' }], rowCount: 1 }
    })
    expect(await resolveTokenToUserId(client, 'plnnn_anything')).toBe('u1')
  })

  it('returns null when no row matched (unknown or expired)', async () => {
    const client = makeClient(() => ({ rows: [], rowCount: 0 }))
    expect(await resolveTokenToUserId(client, 'plnnn_bogus')).toBeNull()
  })

  it('hashes the input with sha-256', async () => {
    let queriedHash: Buffer | null = null
    const client = makeClient((_sql, params) => {
      queriedHash = params[0] as Buffer
      return { rows: [], rowCount: 0 }
    })
    await resolveTokenToUserId(client, 'plnnn_test')
    expect(queriedHash).toEqual(createHash('sha256').update('plnnn_test').digest())
  })
})
