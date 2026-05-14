// Shared pg pool + per-connection user-context helper for the backend.
//
// Matches the shape of mcp/src/db.ts: opens a pooled client, sets both the
// Tier 0 GUC (app.current_user_id) and the Tier 1 GUC (request.jwt.claim.sub)
// inside a transaction so auth.uid() resolves identically across tiers.

import pg from 'pg'

const { Pool } = pg
type PoolClient = pg.PoolClient

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (set by bootstrap.sh)')
}

export const pool = new Pool({ connectionString: DATABASE_URL })

/**
 * Run `fn` inside a transaction with the user-context GUCs set to `userId`.
 * The GUCs are transaction-local (`set_config(..., true)`), so they die on
 * commit/rollback — no leak between checkouts.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Tier 0: app.current_user_id is read by the stub auth.uid() in the overlay.
    // Tier 1: request.jwt.claim.sub is read by Supabase's real auth.uid(), so we
    // set both — same backend code drives both tiers without runtime branching.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
