# MCP Multi-User PAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared `MCP_BEARER_TOKEN` with per-user Personal Access Tokens so multiple humans can share one tier-1/tier-2 Plannen deployment with RLS-scoped access.

**Architecture:** New `plannen.user_tokens` table holds sha-256-hashed `plnnn_…` opaque tokens. The MCP edge function resolves each request's bearer to a user_id via one indexed DB lookup and sets the existing `app.current_user_id` / `request.jwt.claim.sub` GUCs so RLS applies naturally. Tokens are minted from the CLI (admin shortcut, direct DB write) or via a new `mcp-token` edge function (invited users sign in to /settings). Tier 0 untouched; other edge functions untouched.

**Tech Stack:** PostgreSQL + RLS, Deno edge functions, Node CLI (citty), React (web UI), Supabase Auth JWTs (for mint endpoint).

**Spec:** [`docs/superpowers/specs/2026-05-19-mcp-multi-user-pat-design.md`](../specs/2026-05-19-mcp-multi-user-pat-design.md)

**Working branch:** `worktree-feat+mcp_multi_user` (will be renamed to `feat/mcp_multi_user` at PR time).

---

## Task 1: Create `plannen.user_tokens` migration

**Files:**
- Create: `supabase/migrations/20260519180000_user_tokens.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- supabase/migrations/20260519180000_user_tokens.sql
--
-- Per-user MCP Personal Access Tokens. Replaces the shared MCP_BEARER_TOKEN.
-- Validation in supabase/functions/mcp/server.ts hashes the supplied bearer
-- and looks it up here; rows return user_id which the function sets as
-- app.current_user_id so RLS policies on every other table scope naturally.

create table if not exists plannen.user_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references plannen.users(id) on delete cascade,
  label         text not null check (length(trim(label)) > 0),
  token_hash    bytea not null,
  prefix        text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz
);

create unique index if not exists user_tokens_token_hash_idx
  on plannen.user_tokens (token_hash);

create index if not exists user_tokens_user_id_idx
  on plannen.user_tokens (user_id);

alter table plannen.user_tokens enable row level security;

create policy user_tokens_select_self on plannen.user_tokens
  for select using (user_id = auth.uid());
create policy user_tokens_insert_self on plannen.user_tokens
  for insert with check (user_id = auth.uid());
create policy user_tokens_delete_self on plannen.user_tokens
  for delete using (user_id = auth.uid());
-- No UPDATE policy: tokens are immutable once minted.
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx plannen migrate`
Expected: migration applied, no errors.

- [ ] **Step 3: Verify schema**

Run:
```bash
psql "$DATABASE_URL" -c "\d plannen.user_tokens"
psql "$DATABASE_URL" -c "SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'plannen.user_tokens'::regclass;"
```
Expected: table shows columns id/user_id/label/token_hash/prefix/created_at/last_used_at/expires_at; four policies (select, insert, delete, plus implicit). Note: only 3 explicit policies — that's correct.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260519180000_user_tokens.sql
git commit -m "feat(db): add plannen.user_tokens for per-user MCP PATs"
```

---

## Task 2: Edge-runtime helper `_shared/userTokens.ts`

**Files:**
- Create: `supabase/functions/_shared/userTokens.ts`
- Test: `supabase/functions/_shared/userTokens.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail (module not found)**

Run: `cd supabase/functions && npx vitest run _shared/userTokens.test.ts`
Expected: FAIL with "Cannot find module './userTokens.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/userTokens.ts
//
// Per-user MCP PAT helpers. Used by:
//  - supabase/functions/mcp-token/index.ts (mint endpoint)
//  - supabase/functions/mcp/server.ts (resolveTokenToUserId on every request)
//
// A Node twin lives at scripts/lib/userTokens.mjs for CLI use. Keep them
// behaviourally identical.

import { createHash, randomBytes } from 'node:crypto'

export const PLNNN_PREFIX = 'plnnn_'

type Client = {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>
}

export type MintResult = { id: string; plaintext: string; prefix: string }

export async function mintToken(
  client: Client,
  userId: string,
  label: string,
  expiresAt?: string | null,
): Promise<MintResult> {
  if (!label || label.trim().length === 0) {
    throw new Error('label must be a non-empty string')
  }
  // 32 random bytes → 43 base64url chars (no padding). Total length ~49.
  const random = randomBytes(32).toString('base64url')
  const plaintext = `${PLNNN_PREFIX}${random}`
  const hash = createHash('sha256').update(plaintext).digest()
  const prefix = plaintext.slice(0, 12)

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO plannen.user_tokens (user_id, label, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, label.trim(), hash, prefix, expiresAt ?? null],
  )
  return { id: rows[0].id, plaintext, prefix }
}

export type TokenRow = {
  id: string
  label: string
  prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

export async function listTokens(client: Client, userId: string): Promise<TokenRow[]> {
  const { rows } = await client.query<TokenRow>(
    `SELECT id, label, prefix, created_at, last_used_at, expires_at
       FROM plannen.user_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  )
  return rows
}

export async function revokeToken(
  client: Client,
  userId: string,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM plannen.user_tokens WHERE user_id = $1 AND id = $2`,
    [userId, id],
  )
  return (r.rowCount ?? 0) > 0
}

export async function resolveTokenToUserId(
  client: Client,
  plaintext: string,
): Promise<string | null> {
  const hash = createHash('sha256').update(plaintext).digest()
  const { rows } = await client.query<{ user_id: string }>(
    `UPDATE plannen.user_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING user_id`,
    [hash],
  )
  return rows[0]?.user_id ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions && npx vitest run _shared/userTokens.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/userTokens.ts supabase/functions/_shared/userTokens.test.ts
git commit -m "feat(functions): add userTokens helper (mint/list/revoke/resolve)"
```

---

## Task 3: Node-runtime helper `scripts/lib/userTokens.mjs`

**Files:**
- Create: `scripts/lib/userTokens.mjs`
- Test: `scripts/lib/userTokens.test.mjs`

This is the Node twin of the helper from Task 2. Same API, same behaviour, but written for Node directly (no `npm:` specifiers, no Deno globals).

- [ ] **Step 1: Write the failing test file**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/lib/userTokens.test.mjs`
Expected: FAIL with "Cannot find module './userTokens.mjs'".

- [ ] **Step 3: Write the implementation**

```js
// scripts/lib/userTokens.mjs
//
// Node twin of supabase/functions/_shared/userTokens.ts. Same API, same
// behaviour. Used by cli/commands/token/*.mjs.

import { createHash, randomBytes } from 'node:crypto';

export const PLNNN_PREFIX = 'plnnn_';

export async function mintToken(client, userId, label, expiresAt = null) {
  if (!label || label.trim().length === 0) {
    throw new Error('label must be a non-empty string');
  }
  const random = randomBytes(32).toString('base64url');
  const plaintext = `${PLNNN_PREFIX}${random}`;
  const hash = createHash('sha256').update(plaintext).digest();
  const prefix = plaintext.slice(0, 12);

  const { rows } = await client.query(
    `INSERT INTO plannen.user_tokens (user_id, label, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, label.trim(), hash, prefix, expiresAt],
  );
  return { id: rows[0].id, plaintext, prefix };
}

export async function listTokens(client, userId) {
  const { rows } = await client.query(
    `SELECT id, label, prefix, created_at, last_used_at, expires_at
       FROM plannen.user_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeToken(client, userId, id) {
  const r = await client.query(
    `DELETE FROM plannen.user_tokens WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function resolveTokenToUserId(client, plaintext) {
  const hash = createHash('sha256').update(plaintext).digest();
  const { rows } = await client.query(
    `UPDATE plannen.user_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING user_id`,
    [hash],
  );
  return rows[0]?.user_id ?? null;
}

export function looksLikePat(s) {
  return typeof s === 'string' && s.startsWith(PLNNN_PREFIX) && s.length >= 48 && s.length <= 64;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/lib/userTokens.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/userTokens.mjs scripts/lib/userTokens.test.mjs
git commit -m "feat(cli): add Node userTokens helper (twin of Deno _shared)"
```

---

## Task 4: Rewrite `mcp/index.ts` `authenticate()`

**Files:**
- Modify: `supabase/functions/mcp/index.ts`
- Modify: `supabase/functions/mcp/index.test.ts`

The current `authenticate()` returns `Response | null`. We change it to return `{ bearer: string } | Response` so the caller has the bearer for downstream lookup.

- [ ] **Step 1: Update the failing tests first**

Replace the existing `describe('authenticate', …)` block in `supabase/functions/mcp/index.test.ts` with:

```ts
describe('authenticate', () => {
  it('returns the bearer when header is well-formed and prefixed plnnn_', () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer plnnn_abc123' },
    })
    const r = authenticate(req)
    expect(r).not.toBeInstanceOf(Response)
    expect((r as { bearer: string }).bearer).toBe('plnnn_abc123')
  })

  it('returns 401 missing_bearer when header is absent', async () => {
    const req = new Request('http://x/')
    const r = authenticate(req)
    expect(r).toBeInstanceOf(Response)
    const res = r as Response
    expect(res.status).toBe(401)
    expect(await res.clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 missing_bearer when header is missing Bearer prefix', async () => {
    const req = new Request('http://x/', { headers: { Authorization: 'plnnn_abc' } })
    const r = authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 invalid_token_format when bearer does not start with plnnn_', async () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wrongtoken' },
    })
    const r = authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'invalid_token_format' })
  })
})
```

Also delete the `beforeEach(() => { process.env.MCP_BEARER_TOKEN = 'test-token-abc' })` from this describe block — we no longer read that env var.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts -t authenticate`
Expected: FAIL — old `authenticate` returns `null` for the valid case, doesn't match new `{ bearer }` shape.

- [ ] **Step 3: Rewrite `authenticate` in `supabase/functions/mcp/index.ts`**

Replace the entire current `authenticate` function (lines 33-52) and the `constantTimeEqual` helper above it (lines 26-31) with:

```ts
function reply401(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function authenticate(req: Request): { bearer: string } | Response {
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return reply401('missing_bearer')
  const bearer = header.slice(prefix.length)
  if (!bearer.startsWith('plnnn_')) return reply401('invalid_token_format')
  return { bearer }
}
```

Also update `handleRequest` to use the new shape — replace the `if (authFailed) return authFailed` block with:

```ts
const auth = authenticate(req)
if (auth instanceof Response) return auth
// auth.bearer is now available for downstream resolution.
```

- [ ] **Step 4: Run tests to verify authenticate-specific cases pass**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts -t authenticate`
Expected: all 4 authenticate tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/index.ts supabase/functions/mcp/index.test.ts
git commit -m "refactor(mcp): authenticate() returns bearer for downstream PAT resolution"
```

---

## Task 5: Per-request resolve in `mcp/server.ts`

**Files:**
- Modify: `supabase/functions/mcp/server.ts`

Remove the module-level `_userId` cache and `PLANNEN_USER_EMAIL` resolution. Take the bearer from `handleRequest`, look it up per request, then proceed.

- [ ] **Step 1: Modify `buildServer` to accept and use the bearer**

Replace the current contents of `supabase/functions/mcp/server.ts` with:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Pool } from 'npm:pg@8'
import { resolveTokenToUserId } from '../_shared/userTokens.ts'
import type { ToolModule } from './types.ts'

declare const Deno: { env: { get(k: string): string | undefined } } | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const pool = new Pool({ connectionString: envGet('DATABASE_URL') || envGet('SUPABASE_DB_URL') })

/**
 * Build a Server with the supplied tool modules wired in. The bearer must be
 * supplied per request — there is no module-level user cache so two
 * concurrent users hitting the same function instance get distinct sessions.
 */
export function buildServer(modules: ToolModule[], bearer: string) {
  const server = new Server(
    { name: 'plannen', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const definitions = modules.flatMap((m) => m.definitions)
  const dispatch: Record<string, ToolModule['dispatch'][string]> = {}
  for (const m of modules) Object.assign(dispatch, m.dispatch)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = dispatch[req.params.name]
    if (!handler) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      }
    }
    const client = await pool.connect()
    try {
      // Pre-auth lookup: runs as the service connection (no GUC set yet).
      const userId = await resolveTokenToUserId(client, bearer)
      if (!userId) {
        return { content: [{ type: 'text', text: 'invalid_token' }], isError: true }
      }
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
      const result = await handler(req.params.arguments ?? {}, { client, userId })
      await client.query('COMMIT')
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: msg }], isError: true }
    } finally {
      client.release()
    }
  })

  return server
}

export { pool }
```

- [ ] **Step 2: Update `handleRequest` in `supabase/functions/mcp/index.ts` to pass the bearer**

Find the `handleRequest` function. Replace:

```ts
const server = buildServer(opts.tools)
```

with:

```ts
const server = buildServer(opts.tools, auth.bearer)
```

(The `auth` variable was introduced in Task 4 Step 3.)

- [ ] **Step 3: Update the existing transport tests to mint a real token**

In `supabase/functions/mcp/index.test.ts`, find the `describe('handleRequest (transport)', …)` block. The current tests use `Authorization: Bearer test-token-abc`. They need a token that the mocked DB lookup will return a user for.

Add this at the top of the `handleRequest` describe block:

```ts
import { vi } from 'vitest'
import * as userTokensModule from '../_shared/userTokens.ts'

beforeEach(() => {
  vi.spyOn(userTokensModule, 'resolveTokenToUserId').mockResolvedValue('u-test')
  delete process.env.MCP_BEARER_TOKEN
  delete process.env.PLANNEN_USER_EMAIL
})

afterEach(() => {
  vi.restoreAllMocks()
})
```

Update each request in this describe to use a `plnnn_` bearer:

```ts
headers: {
  'Authorization': 'Bearer plnnn_test',
  // ...rest unchanged
}
```

Replace any direct DB-touch in these tests with the mock above (the existing tests pass `{ tools: [] }` so no tool dispatch happens — but `pool.connect()` does still get called in our new flow on a real call). For tests that fire `tools/call`, also stub the pool by mocking the module's `pool` export. Look at the existing test structure and apply the minimal mock to keep them passing.

- [ ] **Step 4: Run the transport tests**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts -t 'handleRequest'`
Expected: all transport tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/server.ts supabase/functions/mcp/index.ts supabase/functions/mcp/index.test.ts
git commit -m "refactor(mcp): per-request token resolve, remove module-level user cache"
```

---

## Task 6: Multi-user isolation regression test

**Files:**
- Modify: `supabase/functions/mcp/index.test.ts`

The whole point of removing the module-level `_userId` cache is to prevent identity leakage across requests. Add an explicit regression test.

- [ ] **Step 1: Write the failing test**

Append to `supabase/functions/mcp/index.test.ts`:

```ts
import { eventsModule } from './tools/events.ts'

describe('multi-user isolation', () => {
  beforeEach(() => {
    delete process.env.MCP_BEARER_TOKEN
    delete process.env.PLANNEN_USER_EMAIL
  })

  it('two requests with different PATs get different userIds in handler ctx', async () => {
    const seenUserIds: string[] = []
    const fakeTool: any = {
      definitions: [{ name: 'echo_user', description: 'd', inputSchema: { type: 'object' } }],
      dispatch: {
        echo_user: async (_args: unknown, ctx: { userId: string }) => {
          seenUserIds.push(ctx.userId)
          return { userId: ctx.userId }
        },
      },
    }

    // Each bearer maps to a different user.
    vi.spyOn(userTokensModule, 'resolveTokenToUserId').mockImplementation(
      async (_c, plaintext: string) => (plaintext === 'plnnn_A' ? 'u-A' : 'u-B'),
    )

    // Mock the pool so we don't hit a real DB.
    const fakeClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    }
    const poolMod = await import('./server.ts')
    vi.spyOn(poolMod.pool, 'connect').mockResolvedValue(fakeClient as any)

    const callBody = (id: number) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'echo_user', arguments: {} },
    })

    const r1 = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer plnnn_A',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: callBody(1),
      }),
      { tools: [fakeTool] },
    )
    expect(r1.status).toBe(200)

    const r2 = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer plnnn_B',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: callBody(2),
      }),
      { tools: [fakeTool] },
    )
    expect(r2.status).toBe(200)

    expect(seenUserIds).toEqual(['u-A', 'u-B'])
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts -t 'multi-user isolation'`
Expected: PASS (Task 5 already removed the singleton; this is a regression guard).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/mcp/index.test.ts
git commit -m "test(mcp): multi-user isolation regression — two PATs, two userIds"
```

---

## Task 7: New `mcp-token` edge function

**Files:**
- Create: `supabase/functions/mcp-token/index.ts`
- Create: `supabase/functions/mcp-token/index.test.ts`

Backs the web UI. Authenticates with `_shared/jwt.ts:verifyJwt()` (the user's Supabase session). POST = mint, GET = list, DELETE = revoke.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/mcp-token/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../_shared/jwt.ts', () => ({
  verifyJwt: vi.fn(),
}))

import { verifyJwt } from '../_shared/jwt.ts'
import { handle } from './index.ts'

function makeCtx(rows: Record<string, unknown[]>) {
  return {
    db: {
      query: vi.fn(async (sql: string, _params: unknown[] = []) => {
        if (sql.includes('INSERT')) return { rows: rows.insert ?? [{ id: 't1' }], rowCount: 1 }
        if (sql.match(/SELECT.*FROM plannen\.user_tokens/i)) return { rows: rows.select ?? [], rowCount: rows.select?.length ?? 0 }
        if (sql.includes('DELETE')) return { rows: [], rowCount: rows.delete?.[0]?.rowCount ?? 1 }
        return { rows: [], rowCount: 0 }
      }),
    },
  }
}

beforeEach(() => {
  (verifyJwt as any).mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('mcp-token handler', () => {
  it('returns 401 when JWT verification fails', async () => {
    ;(verifyJwt as any).mockRejectedValue(new Error('Missing Authorization header'))
    const req = new Request('http://x/', { method: 'POST', body: JSON.stringify({ label: 'a' }) })
    const res = await handle(req, makeCtx({}) as any)
    expect(res.status).toBe(401)
  })

  it('POST mints and returns plaintext once', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'MacBook' }),
    })
    const res = await handle(req, makeCtx({ insert: [{ id: 't-new' }] }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plaintext.startsWith('plnnn_')).toBe(true)
    expect(body.id).toBe('t-new')
    expect(body.label).toBe('MacBook')
  })

  it('POST rejects empty label with 400', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    })
    const res = await handle(req, makeCtx({}) as any)
    expect(res.status).toBe(400)
  })

  it('GET returns caller rows without plaintext', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handle(req, makeCtx({
      select: [{ id: 't1', label: 'a', prefix: 'plnnn_aaa', created_at: 'x', last_used_at: null, expires_at: null }],
    }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).not.toHaveProperty('token_hash')
    expect(body[0]).not.toHaveProperty('plaintext')
  })

  it('DELETE 204 on owned token, 404 on missing/not-yours', async () => {
    ;(verifyJwt as any).mockResolvedValue('u1')

    const reqOk = new Request('http://x/t1', { method: 'DELETE' })
    const resOk = await handle(reqOk, makeCtx({ delete: [{ rowCount: 1 }] }) as any)
    expect(resOk.status).toBe(204)

    const reqMiss = new Request('http://x/tX', { method: 'DELETE' })
    const resMiss = await handle(reqMiss, makeCtx({ delete: [{ rowCount: 0 }] }) as any)
    expect(resMiss.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd supabase/functions && npx vitest run mcp-token/index.test.ts`
Expected: FAIL with "Cannot find module './index.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/mcp-token/index.ts
//
// Per-user MCP PAT management — used by /settings in the web UI.
// Authenticates with the user's Supabase JWT (verifyJwt). All operations
// are scoped to that user.
//
// POST   { label, expires_at? }   → 200 { id, plaintext, prefix, label, created_at, expires_at }
// GET                              → 200 [ { id, label, prefix, created_at, last_used_at, expires_at } ]
// DELETE /:id                      → 204 on success, 404 if not owned by caller

import { Pool } from 'npm:pg@8'
import { verifyJwt } from '../_shared/jwt.ts'
import { mintToken, listTokens, revokeToken } from '../_shared/userTokens.ts'

declare const Deno:
  | {
      env: { get(k: string): string | undefined }
      serve: (handler: (req: Request) => Promise<Response> | Response) => void
    }
  | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const pool = new Pool({ connectionString: envGet('DATABASE_URL') || envGet('SUPABASE_DB_URL') })

type Ctx = { db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> } }

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  let userId: string
  try {
    userId = await verifyJwt(req.headers.get('Authorization'))
  } catch (e) {
    return jsonResp(401, { error: 'unauthenticated', detail: (e as Error).message })
  }

  if (req.method === 'POST') {
    let body: { label?: string; expires_at?: string | null }
    try { body = await req.json() } catch { return jsonResp(400, { error: 'invalid_json' }) }
    if (!body.label || body.label.trim().length === 0) {
      return jsonResp(400, { error: 'label_required' })
    }
    const r = await mintToken(ctx.db as any, userId, body.label, body.expires_at ?? null)
    return jsonResp(200, {
      id: r.id, plaintext: r.plaintext, prefix: r.prefix, label: body.label.trim(),
      created_at: new Date().toISOString(),
      expires_at: body.expires_at ?? null,
    })
  }

  if (req.method === 'GET') {
    const rows = await listTokens(ctx.db as any, userId)
    return jsonResp(200, rows)
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
    if (!id) return jsonResp(400, { error: 'id_required' })
    const ok = await revokeToken(ctx.db as any, userId, id)
    return ok ? new Response(null, { status: 204 }) : jsonResp(404, { error: 'not_found' })
  }

  return jsonResp(405, { error: 'method_not_allowed' })
}

if (typeof Deno !== 'undefined') {
  Deno.serve(async (req) => {
    const client = await pool.connect()
    try {
      const ctx: Ctx = { db: { query: (sql, params) => client.query(sql, params) } }
      return await handle(req, ctx)
    } finally {
      client.release()
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions && npx vitest run mcp-token/index.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp-token/index.ts supabase/functions/mcp-token/index.test.ts
git commit -m "feat(functions): add mcp-token endpoint for web-UI PAT management"
```

---

## Task 8: `plannen token create` CLI verb

**Files:**
- Create: `cli/commands/token/create.mjs`
- Create: `cli/commands/token/index.mjs` (will hold the subcommand group; add `create` only here for now)
- Test: `cli/__tests__/token-create.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// cli/__tests__/token-create.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
        query: async (sql, params) => {
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
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `npx vitest run cli/__tests__/token-create.test.mjs`
Expected: FAIL — "Cannot find module '../commands/token/create.mjs'".

- [ ] **Step 3: Write the verb implementation**

```js
// cli/commands/token/create.mjs
import { defineCommand } from 'citty';
import pg from 'pg';
import {
  resolveActiveProfile,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
  composeEnv,
} from '../../lib/profiles.mjs';
import { mintToken } from '../../../scripts/lib/userTokens.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  // Reuse the existing scripts/mcp-mode.sh http path: it reads MCP_BEARER_TOKEN
  // from supabase/.env.local and writes plugin.json. The verb has already
  // written it; we just call the script.
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenCreate(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const label = String(args.label ?? '').trim();
  if (!label) throw new Error('label is required (use --label "MacBook")');

  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let plaintext;
  let tokenId;
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = rows[0].id;
      const r = await mintToken(client, userId, label, args.expires ?? null);
      plaintext = r.plaintext;
      tokenId = r.id;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  if (!args['no-activate']) {
    const envPath = getProfileEnvPath(profile, env);
    const current = readEnvFile(envPath);
    current.MCP_BEARER_TOKEN = plaintext;
    writeEnvFile(envPath, current);
    const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
    rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: plaintext });
  }

  const log = ctx.log ?? console;
  log.info?.(`Token created (label: ${label})`);
  log.info?.(plaintext);
  log.info?.('');
  if (args['no-activate']) {
    log.info?.('Save this token now — you will not see it again.');
  } else {
    log.info?.(`Saved to profile "${profile}" as MCP_BEARER_TOKEN.`);
    log.info?.('Updated plugin/.claude-plugin/plugin.json.');
    log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
  }

  return { id: tokenId, plaintext, label };
}

export const tokenCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Create a new MCP Personal Access Token' },
  args: {
    label: { type: 'string', description: 'Token label (e.g. "MacBook")', required: true },
    expires: { type: 'string', description: 'ISO date when the token expires (optional)' },
    'no-activate': { type: 'boolean', description: 'Skip wiring to profile env + plugin.json' },
  },
  async run({ args }) {
    await runTokenCreate(args, {});
  },
});
```

- [ ] **Step 4: Create the token subcommand group**

```js
// cli/commands/token/index.mjs
import { defineCommand } from 'citty';
import { tokenCreateCommand } from './create.mjs';

export const tokenCommand = defineCommand({
  meta: { name: 'token', description: 'Manage MCP Personal Access Tokens' },
  subCommands: {
    create: tokenCreateCommand,
  },
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run cli/__tests__/token-create.test.mjs`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/token/create.mjs cli/commands/token/index.mjs cli/__tests__/token-create.test.mjs
git commit -m "feat(cli): plannen token create"
```

---

## Task 9: `plannen token list` CLI verb

**Files:**
- Create: `cli/commands/token/list.mjs`
- Modify: `cli/commands/token/index.mjs` (register subcommand)
- Test: `cli/__tests__/token-list.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// cli/__tests__/token-list.test.mjs
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
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run cli/__tests__/token-list.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// cli/commands/token/list.mjs
import { defineCommand } from 'citty';
import pg from 'pg';
import {
  resolveActiveProfile,
  composeEnv,
} from '../../lib/profiles.mjs';
import { listTokens } from '../../../scripts/lib/userTokens.mjs';

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

export async function runTokenList(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let rows;
  try {
    const client = await pool.connect();
    try {
      const r = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (r.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      rows = await listTokens(client, r.rows[0].id);
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  const log = ctx.log ?? console;
  if (rows.length === 0) {
    log.info?.('No tokens. Run `plannen token create --label <name>` to mint one.');
    return rows;
  }
  log.info?.(['ID', 'LABEL', 'PREFIX', 'CREATED', 'LAST USED', 'EXPIRES'].join('\t'));
  for (const r of rows) {
    log.info?.([
      r.id.slice(0, 8), r.label, r.prefix, fmt(r.created_at), fmt(r.last_used_at), fmt(r.expires_at),
    ].join('\t'));
  }
  return rows;
}

export const tokenListCommand = defineCommand({
  meta: { name: 'list', description: 'List your MCP Personal Access Tokens' },
  async run({ args }) { await runTokenList(args, {}); },
});
```

- [ ] **Step 4: Register subcommand**

Edit `cli/commands/token/index.mjs`. Add the import + entry:

```js
import { tokenListCommand } from './list.mjs';
// ...
subCommands: {
  create: tokenCreateCommand,
  list: tokenListCommand,
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run cli/__tests__/token-list.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/token/list.mjs cli/commands/token/index.mjs cli/__tests__/token-list.test.mjs
git commit -m "feat(cli): plannen token list"
```

---

## Task 10: `plannen token revoke` CLI verb

**Files:**
- Create: `cli/commands/token/revoke.mjs`
- Modify: `cli/commands/token/index.mjs`
- Test: `cli/__tests__/token-revoke.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// cli/__tests__/token-revoke.test.mjs
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run cli/__tests__/token-revoke.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// cli/commands/token/revoke.mjs
import { defineCommand } from 'citty';
import pg from 'pg';
import { resolveActiveProfile, composeEnv } from '../../lib/profiles.mjs';
import { revokeToken } from '../../../scripts/lib/userTokens.mjs';

export async function runTokenRevoke(args, ctx = {}) {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('id is required (use: plannen token revoke <id>)');

  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  try {
    const client = await pool.connect();
    try {
      const u = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (u.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = u.rows[0].id;
      // Note: revokeToken uses prefix-match on id, allowing the short 8-char id from `token list`.
      const fullIdRows = await client.query(
        `SELECT id FROM plannen.user_tokens WHERE user_id = $1 AND id::text LIKE $2 LIMIT 2`,
        [userId, id + '%'],
      );
      if (fullIdRows.rows.length === 0) throw new Error(`token not found for id "${id}"`);
      if (fullIdRows.rows.length > 1) throw new Error(`id prefix "${id}" is ambiguous — use full UUID from \`plannen token list\``);
      const ok = await revokeToken(client, userId, fullIdRows.rows[0].id);
      if (!ok) throw new Error(`token not found for id "${id}"`);
      const log = ctx.log ?? console;
      log.info?.(`Revoked token ${fullIdRows.rows[0].id}`);
      return true;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }
}

export const tokenRevokeCommand = defineCommand({
  meta: { name: 'revoke', description: 'Revoke an MCP Personal Access Token by id' },
  args: { id: { type: 'positional', required: true } },
  async run({ args }) { await runTokenRevoke(args, {}); },
});
```

- [ ] **Step 4: Register subcommand**

In `cli/commands/token/index.mjs`:

```js
import { tokenRevokeCommand } from './revoke.mjs';
// ...
subCommands: { create: tokenCreateCommand, list: tokenListCommand, revoke: tokenRevokeCommand },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run cli/__tests__/token-revoke.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/token/revoke.mjs cli/commands/token/index.mjs cli/__tests__/token-revoke.test.mjs
git commit -m "feat(cli): plannen token revoke"
```

---

## Task 11: `plannen token activate` CLI verb

**Files:**
- Create: `cli/commands/token/activate.mjs`
- Modify: `cli/commands/token/index.mjs`
- Test: `cli/__tests__/token-activate.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// cli/__tests__/token-activate.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-act-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_TIER=2\nPLANNEN_USER_EMAIL=me@x\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

describe('plannen token activate', () => {
  it('writes PAT to profile env and calls rewritePluginJson', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    const rewrite = vi.fn();
    const pat = 'plnnn_' + 'a'.repeat(43);
    await runTokenActivate({ pat }, { env: { HOME: tmpHome }, rewritePluginJson: rewrite, log: { info: vi.fn() } });

    const envText = readFileSync(path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'), 'utf8');
    expect(envText).toMatch(new RegExp('^MCP_BEARER_TOKEN=' + pat + '$', 'm'));
    expect(rewrite).toHaveBeenCalledOnce();
  });

  it('rejects PATs not starting with plnnn_', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    await expect(runTokenActivate({ pat: 'ghp_garbage' }, { env: { HOME: tmpHome } }))
      .rejects.toThrow(/plnnn_/);
  });

  it('rejects PATs that are too short', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    await expect(runTokenActivate({ pat: 'plnnn_short' }, { env: { HOME: tmpHome } }))
      .rejects.toThrow(/length/i);
  });

  it('does not touch the DB', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    // No poolFactory passed: if the command tried to connect, it'd fail (no real DB).
    const pat = 'plnnn_' + 'b'.repeat(43);
    await runTokenActivate({ pat }, { env: { HOME: tmpHome }, rewritePluginJson: vi.fn(), log: { info: vi.fn() } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run cli/__tests__/token-activate.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// cli/commands/token/activate.mjs
import { defineCommand } from 'citty';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveActiveProfile,
  composeEnv,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
} from '../../lib/profiles.mjs';
import { looksLikePat } from '../../../scripts/lib/userTokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenActivate(args, ctx = {}) {
  const pat = String(args.pat ?? '').trim();
  if (!pat.startsWith('plnnn_')) {
    throw new Error('PAT must start with plnnn_ (got: ' + (pat.slice(0, 8) || 'empty') + '…)');
  }
  if (!looksLikePat(pat)) {
    throw new Error('PAT length is wrong (expected ~49 chars)');
  }

  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const envPath = getProfileEnvPath(profile, env);
  const current = readEnvFile(envPath);
  current.MCP_BEARER_TOKEN = pat;
  writeEnvFile(envPath, current);

  const composed = composeEnv(profile, {}, env);
  const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
  rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: pat });

  const log = ctx.log ?? console;
  log.info?.(`PAT activated for profile "${profile}".`);
  log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
}

export const tokenActivateCommand = defineCommand({
  meta: { name: 'activate', description: 'Wire a PAT (from /settings) into the active profile + plugin.json' },
  args: { pat: { type: 'positional', required: true } },
  async run({ args }) { await runTokenActivate(args, {}); },
});
```

- [ ] **Step 4: Register subcommand**

In `cli/commands/token/index.mjs`:

```js
import { tokenActivateCommand } from './activate.mjs';
// ...
subCommands: { create: ..., list: ..., revoke: ..., activate: tokenActivateCommand },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run cli/__tests__/token-activate.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/token/activate.mjs cli/commands/token/index.mjs cli/__tests__/token-activate.test.mjs
git commit -m "feat(cli): plannen token activate"
```

---

## Task 12: `plannen token rotate` CLI verb

**Files:**
- Create: `cli/commands/token/rotate.mjs`
- Modify: `cli/commands/token/index.mjs`
- Test: `cli/__tests__/token-rotate.test.mjs`

Behaviour: read current `MCP_BEARER_TOKEN` from active profile env → if it's a `plnnn_…` PAT, look up its DB id and revoke it → mint a fresh PAT (label `"rotated-<ISO date>"`) → write to profile env + plugin.json.

- [ ] **Step 1: Write the failing test**

```js
// cli/__tests__/token-rotate.test.mjs
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run cli/__tests__/token-rotate.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// cli/commands/token/rotate.mjs
import { defineCommand } from 'citty';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  resolveActiveProfile,
  composeEnv,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
} from '../../lib/profiles.mjs';
import { mintToken, revokeToken } from '../../../scripts/lib/userTokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenRotate(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  const current = composed.MCP_BEARER_TOKEN;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');
  if (!current) throw new Error('MCP_BEARER_TOKEN not set in active profile env — nothing to rotate');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let newPat;
  try {
    const client = await pool.connect();
    try {
      const u = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1', [email],
      );
      if (u.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = u.rows[0].id;

      // Look up the existing token by hash; revoke if found (silent no-op if not).
      const hash = createHash('sha256').update(current).digest();
      const existing = await client.query(
        `SELECT id FROM plannen.user_tokens WHERE user_id = $1 AND token_hash = $2 LIMIT 1`,
        [userId, hash],
      );
      if (existing.rows.length > 0) {
        await revokeToken(client, userId, existing.rows[0].id);
      }

      const label = `rotated-${new Date().toISOString().slice(0, 10)}`;
      const r = await mintToken(client, userId, label);
      newPat = r.plaintext;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  const envPath = getProfileEnvPath(profile, env);
  const e = readEnvFile(envPath);
  e.MCP_BEARER_TOKEN = newPat;
  writeEnvFile(envPath, e);

  const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
  rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: newPat });

  const log = ctx.log ?? console;
  log.info?.('Rotated MCP_BEARER_TOKEN.');
  log.info?.(newPat);
  log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
}

export const tokenRotateCommand = defineCommand({
  meta: { name: 'rotate', description: 'Revoke the current MCP_BEARER_TOKEN and mint a fresh one' },
  async run({ args }) { await runTokenRotate(args, {}); },
});
```

- [ ] **Step 4: Register subcommand**

In `cli/commands/token/index.mjs`:

```js
import { tokenRotateCommand } from './rotate.mjs';
// ...
subCommands: { create: ..., list: ..., revoke: ..., activate: ..., rotate: tokenRotateCommand },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run cli/__tests__/token-rotate.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/token/rotate.mjs cli/commands/token/index.mjs cli/__tests__/token-rotate.test.mjs
git commit -m "feat(cli): plannen token rotate (replaces scripts/mcp-rotate-bearer.sh)"
```

---

## Task 13: Wire `plannen token` namespace into the CLI

**Files:**
- Modify: `cli/main.mjs`

- [ ] **Step 1: Add the import and subCommand entry**

In `cli/main.mjs`, after the existing `import { functionsCommand } from './commands/functions/index.mjs';` line, add:

```js
import { tokenCommand } from './commands/token/index.mjs';
```

In the `subCommands` block of the `defineCommand({…})` call, add:

```js
    token: tokenCommand,
```

(between `functions: functionsCommand,` and the closing brace).

- [ ] **Step 2: Smoke-test the dispatch**

Run: `node cli/main.mjs token --help`
Expected: shows `token` subcommand description and lists `create`, `list`, `revoke`, `activate`, `rotate`.

- [ ] **Step 3: Commit**

```bash
git add cli/main.mjs
git commit -m "feat(cli): wire plannen token subcommand group"
```

---

## Task 14: Update `cloud provision` to auto-mint admin PAT

**Files:**
- Modify: `cli/commands/cloud/provision.mjs`
- Modify: `cli/__tests__/cloud-provision.test.mjs`
- Modify: `cli/commands/functions/deploy.mjs` (drop the MCP_BEARER_TOKEN secret push)
- Modify: `cli/commands/promote.mjs` (same — drop MCP_BEARER_TOKEN from promote)

Provision today calls `scripts/lib/mcp-rotate-bearer.mjs` to make up a shared bearer and push it to Supabase secrets. New behaviour: after migrations are applied and the admin's `plannen.users` row exists, mint a real PAT directly via `mintToken`, write to profile env. **No `supabase secrets set MCP_BEARER_TOKEN`** — the function no longer reads it.

- [ ] **Step 1: Locate the provision step that today generates the bearer**

```bash
grep -n "mcpBearerToken\|mcp-rotate-bearer\|MCP_BEARER_TOKEN" cli/commands/cloud/provision.mjs
```

Note the line numbers — you'll modify those lines in Step 2.

- [ ] **Step 2: Replace the bearer generation with mintToken**

In `cli/commands/cloud/provision.mjs`, find the block that calls `mcp-rotate-bearer.mjs` (or imports `cloudDeploy`'s helper that does). Replace it with:

```js
// Auto-mint admin's first PAT via the userTokens helper.
import { mintToken as mintTokenFn } from '../../../scripts/lib/userTokens.mjs';
import os from 'node:os';
import pg from 'pg';

// ... inside the provision flow, where the old bearer was generated:
const pool = new pg.Pool({ connectionString: composed.DATABASE_URL });
let mcpBearerToken;
try {
  const client = await pool.connect();
  try {
    const u = await client.query(
      'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [composed.PLANNEN_USER_EMAIL],
    );
    if (u.rows.length === 0) throw new Error(`provision: plannen.users row for ${composed.PLANNEN_USER_EMAIL} missing — schema push step did not create it`);
    const r = await mintTokenFn(client, u.rows[0].id, `provision-${os.hostname()}`);
    mcpBearerToken = r.plaintext;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
```

Make sure `mcpBearerToken` is then written into the profile env in the existing block that writes `MCP_BEARER_TOKEN: result.mcpBearerToken`.

**Remove** the call that pushes `MCP_BEARER_TOKEN` to Supabase secrets (it's no longer read by the function). Search for `supabase secrets set` and the entry for `MCP_BEARER_TOKEN` in `cli/commands/functions/deploy.mjs` and `cli/commands/promote.mjs`; delete those lines.

- [ ] **Step 3: Update the existing test assertion**

In `cli/__tests__/cloud-provision.test.mjs`, find the line:

```js
expect(profEnv.MCP_BEARER_TOKEN).toBe('bearer-xyz');
```

Replace with:

```js
expect(profEnv.MCP_BEARER_TOKEN).toMatch(/^plnnn_/);
expect(profEnv.MCP_BEARER_TOKEN.length).toBeGreaterThanOrEqual(48);
```

Also: the test will now need to mock `pg.Pool` since the new code path opens a real DB connection. Add at the top of the test file:

```js
vi.mock('pg', () => ({
  default: {
    Pool: class FakePool {
      async connect() {
        return {
          query: async (sql) => {
            if (sql.includes('SELECT id FROM plannen.users')) return { rows: [{ id: 'u-admin' }], rowCount: 1 };
            if (sql.includes('INSERT INTO plannen.user_tokens')) return { rows: [{ id: 'tok-1' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        };
      }
      async end() {}
    },
  },
}));
```

- [ ] **Step 4: Run the cloud-provision test**

Run: `npx vitest run cli/__tests__/cloud-provision.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/cloud/provision.mjs cli/commands/functions/deploy.mjs cli/commands/promote.mjs cli/__tests__/cloud-provision.test.mjs
git commit -m "feat(cli): cloud provision auto-mints admin PAT instead of shared bearer"
```

---

## Task 15: Delete legacy `mcp-rotate-bearer` scripts

**Files:**
- Delete: `scripts/mcp-rotate-bearer.sh`
- Delete: `scripts/lib/mcp-rotate-bearer.mjs`

- [ ] **Step 1: Confirm nothing references them**

```bash
grep -rn "mcp-rotate-bearer" . --include="*.mjs" --include="*.ts" --include="*.sh" --include="*.md" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v worktrees
```

Expected: matches only in `scripts/mcp-rotate-bearer.sh`, `scripts/lib/mcp-rotate-bearer.mjs`, and possibly README / CHANGELOG (those get updated in Task 18).

- [ ] **Step 2: Delete the files**

```bash
git rm scripts/mcp-rotate-bearer.sh scripts/lib/mcp-rotate-bearer.mjs
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove scripts/mcp-rotate-bearer (superseded by plannen token rotate)"
```

---

## Task 16: New `SettingsTokens` React component

**Files:**
- Create: `src/components/SettingsTokens.tsx`
- Create: `src/components/SettingsTokens.test.tsx`

Smoke-test only — the component fetches from `/functions/v1/mcp-token`, displays the list, has a "Generate" button that POSTs and shows the plaintext once.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/SettingsTokens.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsTokens } from './SettingsTokens';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input, init) => handler(input, init)));
}

describe('SettingsTokens', () => {
  it('lists tokens fetched from /functions/v1/mcp-token', async () => {
    mockFetch(async (url, init) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return new Response(JSON.stringify([
          { id: 't1', label: 'MacBook', prefix: 'plnnn_abc', created_at: '2026-05-01', last_used_at: null, expires_at: null },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });
    render(<SettingsTokens jwt="test-jwt" supabaseUrl="https://x" />);
    await waitFor(() => expect(screen.getByText('MacBook')).toBeInTheDocument());
    expect(screen.getByText(/plnnn_abc/)).toBeInTheDocument();
  });

  it('mints a token on Generate click and shows the plaintext once', async () => {
    const calls: any[] = [];
    mockFetch(async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body });
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({
          id: 't-new', plaintext: 'plnnn_NEW' + 'a'.repeat(40), prefix: 'plnnn_NEW',
          label: 'Laptop', created_at: '2026-05-19', expires_at: null,
        }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    render(<SettingsTokens jwt="test-jwt" supabaseUrl="https://x" />);
    fireEvent.click(screen.getByText(/generate/i));
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByText(/create/i));
    await waitFor(() => expect(screen.getByText(/plnnn_NEW/)).toBeInTheDocument());
    expect(screen.getByText(/save this token/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/components/SettingsTokens.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// src/components/SettingsTokens.tsx
import { useEffect, useState, type FormEvent } from 'react';

type Token = {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

type Props = {
  jwt: string;
  supabaseUrl: string;
};

export function SettingsTokens({ jwt, supabaseUrl }: Props) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [justMinted, setJustMinted] = useState<{ plaintext: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `${supabaseUrl}/functions/v1/mcp-token`;
  const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { headers });
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      setTokens(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      const body = await res.json();
      setJustMinted({ plaintext: body.plaintext, label: body.label });
      setShowCreate(false);
      setLabel('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onRevoke(id: string) {
    if (!confirm('Revoke this token? It cannot be undone.')) return;
    try {
      const res = await fetch(`${endpoint}/${id}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 204) throw new Error(`revoke failed: ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <h2>Personal access tokens</h2>
      <p>Use these to authenticate Claude Code (and other MCP clients) to your Plannen deployment.</p>
      {error && <div role="alert">{error}</div>}

      {justMinted && (
        <div role="dialog" aria-label="Token created">
          <p><strong>Save this token now — you will not see it again.</strong></p>
          <code>{justMinted.plaintext}</code>
          <button onClick={() => navigator.clipboard?.writeText(justMinted.plaintext)}>Copy</button>
          <button onClick={() => setJustMinted(null)}>I've saved this token</button>
        </div>
      )}

      <button onClick={() => setShowCreate(true)}>Generate new token</button>

      {showCreate && (
        <form onSubmit={onCreate}>
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </label>
          <button type="submit">Create</button>
          <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
        </form>
      )}

      {loading ? <p>Loading…</p> : (
        <table>
          <thead>
            <tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td><code>{t.prefix}</code></td>
                <td>{t.created_at?.slice(0, 10)}</td>
                <td>{t.last_used_at ? t.last_used_at.slice(0, 10) : '—'}</td>
                <td>{t.expires_at ? t.expires_at.slice(0, 10) : 'never'}</td>
                <td><button onClick={() => onRevoke(t.id)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/SettingsTokens.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsTokens.tsx src/components/SettingsTokens.test.tsx
git commit -m "feat(web): SettingsTokens component for /settings PAT management"
```

---

## Task 17: Mount `SettingsTokens` in `Settings.tsx`

**Files:**
- Modify: `src/components/Settings.tsx`

- [ ] **Step 1: Open the file and locate where existing settings panels are rendered**

```bash
grep -n "BYOK\|Anthropic\|api_key\|section\|<h2" src/components/Settings.tsx | head -20
```

- [ ] **Step 2: Mount `SettingsTokens` below the existing BYOK section**

Import at the top:

```tsx
import { SettingsTokens } from './SettingsTokens';
```

Use the existing pattern in `Settings.tsx` for getting `jwt` and `supabaseUrl` (likely from `useAuth()` and `import.meta.env.VITE_SUPABASE_URL`). Add below the existing panels:

```tsx
{session?.access_token && (
  <SettingsTokens
    jwt={session.access_token}
    supabaseUrl={import.meta.env.VITE_SUPABASE_URL ?? ''}
  />
)}
```

(Adjust the prop names — `session.access_token` may instead be `user.token` or similar; inspect the existing imports in this file.)

- [ ] **Step 3: Smoke-test in the browser**

Run: `npm run dev` (in a separate terminal), open `http://localhost:4321/settings`, sign in via magic link, scroll to "Personal access tokens".
Expected: empty table, "Generate new token" button visible. Click → label modal → submit → plaintext shown once → table now has one row.

- [ ] **Step 4: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat(web): mount SettingsTokens panel in /settings"
```

---

## Task 18: README + CHANGELOG + version bump

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Update README**

Find the section in `README.md` that mentions MCP setup / `MCP_BEARER_TOKEN`. Replace with PAT-based instructions. Insert a new section "MCP Personal Access Tokens" with:

```markdown
## MCP Personal Access Tokens

Each user has their own PAT — like a GitHub PAT, but for Plannen. PATs scope every MCP call to the issuing user; RLS handles the rest.

### Admin / dev (you have DB access)

```bash
npx plannen token create --label "MacBook"
```

Mints a `plnnn_…` token, writes it to your active profile's env, and rewires `plugin/.claude-plugin/plugin.json`. Reload the plannen plugin in Claude Code.

### Inviting another user (they don't have DB access)

1. Share your deployment's `SUPABASE_URL` + anon key.
2. They run `npx plannen profile create --mode cloud_sb` and sign in via magic link at the deployment's web URL.
3. /settings → "Personal access tokens" → Generate, save the plaintext.
4. `npx plannen token activate <PAT>` — wires their plugin.

### Verbs

| Verb | What it does |
|---|---|
| `plannen token create --label <name>` | Mint a new PAT, wire it into active profile + plugin.json |
| `plannen token list` | Show your tokens (no plaintext) |
| `plannen token revoke <id>` | Revoke a token |
| `plannen token activate <PAT>` | Wire a PAT from /settings into active profile + plugin.json |
| `plannen token rotate` | Revoke current PAT, mint a fresh one |
```

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## 0.6.0 — 2026-05-19

### Breaking
- **MCP authentication is now per-user PAT, not a shared `MCP_BEARER_TOKEN`.** Existing tier-1/tier-2 deployments must run `npx plannen migrate` then `npx plannen token create --label "$(hostname)"` to mint the admin's first PAT. Other Plannen users generate their own PATs at `/settings` after magic-link sign-in.
- `scripts/mcp-rotate-bearer.sh` removed. Use `plannen token rotate` instead.

### Added
- `plannen.user_tokens` table + RLS policies (forward-only migration).
- `plannen token {create, list, revoke, activate, rotate}` CLI verbs.
- `mcp-token` edge function backing /settings.
- Multi-user isolation regression test in `mcp/index.test.ts`.
- `SettingsTokens` React component in `/settings`.

### Removed
- Shared `MCP_BEARER_TOKEN` env read in `supabase/functions/mcp/index.ts`.
- Module-level `_userId` cache in `supabase/functions/mcp/server.ts`.
- `PLANNEN_USER_EMAIL` read in tier-1/tier-2 MCP function (tier 0 unchanged).
```

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "0.5.1"` (or current) to `"version": "0.6.0"`.

- [ ] **Step 4: Run full test suite**

Run: `npm test` (or whichever script the project uses to run everything)
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "release: 0.6.0 — per-user MCP PATs"
```

---

## Verification before PR

Before opening the PR, sanity check the whole branch:

- [ ] **Run all CLI tests**

Run: `npm run test:cli`
Expected: all token-* tests + cloud-provision pass, plus existing CLI tests still green.

- [ ] **Run all edge-function tests**

Run: `cd supabase/functions && npx vitest run`
Expected: userTokens, mcp-token, mcp/index, mcp/tools/* all pass.

- [ ] **Apply migrations to a fresh DB and verify the schema**

```bash
npx plannen down
rm -rf ~/.plannen/pgdata
npx plannen up
psql "$DATABASE_URL" -c "\d plannen.user_tokens"
```
Expected: table exists with all columns + indexes + RLS.

- [ ] **Mint, list, revoke, activate, rotate — end-to-end smoke test**

```bash
npx plannen token create --label "smoke-test"        # mints + wires
npx plannen token list                                # shows the row
npx plannen token rotate                              # revokes + re-mints
npx plannen token list                                # shows one row, new label "rotated-..."
TID=$(npx plannen token list | awk 'NR==2 {print $1}')
npx plannen token revoke "$TID"
npx plannen token list                                # "No tokens"
```

Expected output matches at each step.

- [ ] **Verify Claude Code can talk to the MCP server with a real PAT**

```bash
npx plannen token create --label "claude-code"
# Reload the plannen plugin in Claude Code.
# In Claude Code, run any plannen MCP tool (e.g. list_events).
```
Expected: tool returns data scoped to the current user.

- [ ] **Push the branch and open a PR**

```bash
# Rename the worktree branch to the canonical name first.
git branch -m worktree-feat+mcp_multi_user feat/mcp_multi_user
git push -u origin feat/mcp_multi_user
gh pr create --title "feat: per-user MCP Personal Access Tokens" --body "$(cat <<'EOF'
## Summary
- Replace the shared `MCP_BEARER_TOKEN` with GitHub-style per-user PATs (`plnnn_…`).
- New `plannen.user_tokens` table with RLS; tokens hashed at rest.
- New CLI: `plannen token {create, list, revoke, activate, rotate}`.
- New edge function `mcp-token` backing /settings.
- MCP function rewrites: per-request token resolve, no module-level user cache (multi-user isolation regression test included).
- Cloud provision auto-mints the admin's first PAT.

Spec: docs/superpowers/specs/2026-05-19-mcp-multi-user-pat-design.md

## Test plan
- [x] All edge-function tests pass
- [x] All CLI tests pass
- [x] End-to-end mint/list/revoke/activate/rotate smoke test
- [x] Claude Code reaches MCP server with a PAT

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
