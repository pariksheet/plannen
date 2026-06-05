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
    `SELECT id, label, prefix, created_at, last_used_at, expires_at FROM plannen.user_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
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
