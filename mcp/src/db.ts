// Shared pg pool + per-connection user-context helper.
//
// Every Plannen tool handler in mcp/src/index.ts wraps its body in
// withUserContext(userId, fn). The helper opens a pooled client, sets the
// `app.current_user_id` GUC for the duration of the transaction (so auth.uid()
// resolves), runs the callback, and releases. The GUC is transaction-local
// (`set_config(..., true)`), so it dies on commit/rollback — no leak.

import pg from 'pg'

const { Pool } = pg
type PoolClient = pg.PoolClient

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (set by bootstrap.sh)')
}

export const pool = new Pool({ connectionString: DATABASE_URL })

export async function withUserContext<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Tier 0: app.current_user_id is read by the stub auth.uid() in the overlay.
    // Tier 1: request.jwt.claim.sub is read by Supabase's real auth.uid(), so we
    // set both — same client code drives both tiers without runtime branching.
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
