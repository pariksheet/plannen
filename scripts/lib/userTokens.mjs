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
