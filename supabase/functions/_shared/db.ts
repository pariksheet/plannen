// pg client opener for Tier 1 edge functions. Each invocation gets a fresh
// client from the module-scoped pool, sets the user-context GUCs inside a
// transaction, runs the handler, and releases. Mirrors the backend
// `withUserContext` shape so handlers behave identically in both tiers.

import { Pool } from 'npm:pg@8'
import type { DbClient } from './handlers/types.ts'

const pool = new Pool({ connectionString: Deno.env.get('DATABASE_URL') ?? '' })

export async function withDb<T>(
  userId: string,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Set both Tier 0 + Tier 1 GUCs so the handler sees a consistent auth.uid().
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_user_id',
      userId,
    ])
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claim.sub',
      userId,
    ])
    const out = await fn(client as unknown as DbClient)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
