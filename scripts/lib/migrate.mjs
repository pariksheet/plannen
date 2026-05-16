#!/usr/bin/env node
// Migration runner.
//
//   Tier 0: apply supabase/migrations-tier0/*.sql FIRST (creates auth/storage
//           stubs + roles the main schema depends on), then supabase/migrations/*.sql.
//   Tier 1: apply only supabase/migrations/*.sql.
//   Tier 2: delegate to `supabase db push` against the linked cloud project.
//           No pg connection from this script — the CLI handles auth + tracking
//           via supabase_migrations.schema_migrations on cloud.
//
// Each migration (Tier 0/1) runs in its own transaction. Successes are
// recorded in plannen.schema_migrations(version, applied_at).
//
// Usage: node scripts/lib/migrate.mjs
// Reads DATABASE_URL and PLANNEN_TIER from env (or repo-root .env if present).

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// Best-effort load of .env at repo root; absent file is fine.
try {
  const { config } = await import('dotenv')
  const envPath = join(REPO_ROOT, '.env')
  if (existsSync(envPath)) config({ path: envPath })
} catch {
  // dotenv not installed at root; rely on caller-supplied env.
}

const DATABASE_URL = process.env.DATABASE_URL
const TIER = process.env.PLANNEN_TIER ?? '0'

// Tier 2: delegate to `supabase db push`. No DATABASE_URL needed locally.
if (TIER === '2') {
  const projectRef = process.env.SUPABASE_PROJECT_REF
  if (!projectRef) {
    console.error('SUPABASE_PROJECT_REF required for Tier 2 migrations')
    process.exit(1)
  }
  const args = ['db', 'push', '--project-ref', projectRef]
  if (process.env.SUPABASE_DB_PUSH_INCLUDE_ALL === '1') args.push('--include-all')
  console.log(`tier 2 → supabase ${args.join(' ')}`)
  const r = spawnSync('supabase', args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`supabase db push failed (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
  console.log('done.')
  process.exit(0)
}

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const MAIN_DIR    = join(REPO_ROOT, 'supabase', 'migrations')
const TIER0_DIR   = join(REPO_ROOT, 'supabase', 'migrations-tier0')

// Tier 0 overlay runs BEFORE main so initial_schema can resolve auth.users etc.
const MIGRATIONS_DIRS = TIER === '0' ? [TIER0_DIR, MAIN_DIR] : [MAIN_DIR]

function listSql(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ version: basename(f, '.sql'), file: join(dir, f) }))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

await client.query(`
  CREATE SCHEMA IF NOT EXISTS plannen;
  CREATE TABLE IF NOT EXISTS plannen.schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`)

const { rows: applied } = await client.query('SELECT version FROM plannen.schema_migrations')
const seen = new Set(applied.map((r) => r.version))

let count = 0
for (const dir of MIGRATIONS_DIRS) {
  for (const { version, file } of listSql(dir)) {
    if (seen.has(version)) continue
    const sql = readFileSync(file, 'utf8')
    process.stdout.write(`applying ${version}... `)
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO plannen.schema_migrations(version) VALUES ($1)', [version])
      await client.query('COMMIT')
      console.log('ok')
      count++
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`FAILED: ${e.message}`)
      process.exit(1)
    }
  }
}

console.log(`done. applied ${count} migration(s).`)
await client.end()
