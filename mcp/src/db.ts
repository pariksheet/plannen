// Shared pg pool + per-connection user-context helper.
//
// Every Plannen tool handler in mcp/src/index.ts wraps its body in
// withUserContext(userId, fn). The helper opens a pooled client, sets the
// `app.current_user_id` GUC for the duration of the transaction (so auth.uid()
// resolves), runs the callback, and releases. The GUC is transaction-local
// (`set_config(..., true)`), so it dies on commit/rollback — no leak.
//
// The MCP server is long-lived but the user's active profile (and therefore
// DATABASE_URL) can change at runtime via `plannen profile use` / `plannen init`,
// which rewrites the `.env` symlink. We watch that file and swap the underlying
// pg.Pool when DATABASE_URL changes, so profile switches don't require a
// Claude Desktop / Claude Code restart. Consumers keep importing `pool`; a
// Proxy forwards their calls to whichever pool is current.

// Side-effect: load repo-root .env BEFORE we read process.env.DATABASE_URL.
// Imports evaluate top-down; this must be first.
import './env.js'

import { watchFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

// Return DATE columns (OID 1082) as raw 'YYYY-MM-DD' strings, not JS Date.
// Keeps mcp tool outputs ISO-clean and matches the backend's behaviour.
pg.types.setTypeParser(1082, (val) => val)

const { Pool } = pg
type PoolClient = pg.PoolClient
type PgPool = InstanceType<typeof Pool>

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env')

let currentDsn = process.env.DATABASE_URL
if (!currentDsn) {
  throw new Error('DATABASE_URL is required (set by bootstrap.sh)')
}

let currentPool: PgPool = new Pool({ connectionString: currentDsn })

// Proxy forwards every property access (connect, query, end, options, ...) to
// the live pool. Lets us replace currentPool without invalidating the `pool`
// import held by index.ts / userResolver.ts / tests.
export const pool = new Proxy({} as PgPool, {
  get(_target, prop) {
    const value = (currentPool as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? (value as Function).bind(currentPool) : value
  },
}) as PgPool

export function swapPoolIfDsnChanged(newDsn: string | undefined): boolean {
  if (!newDsn || newDsn === currentDsn) return false
  const previous = currentPool
  currentDsn = newDsn
  currentPool = new Pool({ connectionString: newDsn })
  // end() waits for outstanding clients to release; safe even if previous was
  // never used. Fire-and-forget so the watcher callback stays sync.
  void previous.end().catch(() => {})
  return true
}

// Poll-based watcher: fs.watch's inode tracking breaks when `.env` is a symlink
// that gets re-pointed (which is exactly what `plannen profile use` does).
// watchFile stat-polls the path, so it catches both symlink retargets and
// in-place edits. persistent:false keeps it from holding the event loop open
// in tests.
watchFile(ENV_PATH, { interval: 1000, persistent: false }, () => {
  loadDotenv({ path: ENV_PATH, override: true })
  if (swapPoolIfDsnChanged(process.env.DATABASE_URL)) {
    const masked = (process.env.DATABASE_URL ?? '').replace(/:[^:@]*@/, ':***@')
    process.stderr.write(`[plannen-mcp] reloaded DB connection: ${masked}\n`)
  }
})

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
