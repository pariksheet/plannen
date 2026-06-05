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
// Usage: node scripts/lib/migrate.mjs [--to <version>]
// Reads DATABASE_URL and PLANNEN_TIER from env (or repo-root .env if present).
// --to bounds the run: migrations sorting after <version> are deferred. Used
// by the seed-restore replay flow (#16) — apply up to the dump's watermark,
// load the dump, then run again unbounded.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { runMigrateTier2 } from '../../cli/lib/migrate-tier2.mjs'
import { withinBound } from './seed-watermark.mjs'

// --to <version>: upper bound for this run (see header comment).
const toIdx = process.argv.indexOf('--to')
const BOUND = toIdx !== -1 ? process.argv[toIdx + 1] : null
if (toIdx !== -1 && !BOUND) {
  console.error('--to requires a migration version argument')
  process.exit(1)
}

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

// Tier 2: delegate to `supabase link` + `supabase db push --linked`. No
// DATABASE_URL needed locally — the Supabase CLI handles auth + version
// tracking via supabase_migrations.schema_migrations on the cloud project.
if (TIER === '2') {
  try {
    await runMigrateTier2({ projectRef: process.env.SUPABASE_PROJECT_REF })
    process.exit(0)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
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
let deferred = 0
for (const dir of MIGRATIONS_DIRS) {
  for (const { version, file } of listSql(dir)) {
    if (seen.has(version)) continue
    if (!withinBound(version, BOUND)) { deferred++; continue }
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

console.log(`done. applied ${count} migration(s).${deferred ? ` deferred ${deferred} past --to ${BOUND}.` : ''}`)
await client.end()
