#!/usr/bin/env node
// Pure-Node table dumper for Tier 0. Sidesteps the pg_dump-vs-server version
// mismatch that hits when the host has Homebrew pg_dump 16 but embedded
// Postgres serves 18+.
//
//   node scripts/lib/dump-tables.mjs > supabase/seed.sql
//
// Output mirrors `pg_dump --data-only --column-inserts`: one
//   INSERT INTO "schema"."table" ("col", ...) VALUES (...);
// per row, in the table order listed below. Reads DATABASE_URL from env.

import pg from 'pg'

const TABLES = [
  'auth.users',
  'plannen.users',
  'plannen.app_allowed_emails',
  'plannen.events',
  'plannen.event_rsvps',
  'plannen.event_invites',
  'plannen.event_memories',
  'plannen.event_shared_with_users',
  'plannen.event_shared_with_groups',
  'plannen.event_sources',
  'plannen.event_source_refs',
  'plannen.relationships',
  'plannen.friend_groups',
  'plannen.friend_group_members',
  'plannen.user_profiles',
  'plannen.user_locations',
  'plannen.user_oauth_tokens',
  'plannen.family_members',
  'plannen.agent_tasks',
  'plannen.profile_facts',
  'plannen.stories',
  'plannen.story_events',
]

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

// Keep DATE columns as 'YYYY-MM-DD' strings so they round-trip cleanly.
pg.types.setTypeParser(1082, (val) => val)
// Keep TIMESTAMPTZ as ISO strings (default JS Date loses tz info via .toISOString
// but that's fine here — TIMESTAMPTZ is timezone-aware and ISO is canonical).

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

function quoteIdent(s) { return '"' + s.replace(/"/g, '""') + '"' }

function quoteLiteral(v, isJsonbCol) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return "'" + v.toISOString() + "'"
  if (Array.isArray(v)) {
    // Postgres array literal: ARRAY[lit, lit, ...]
    // For nested or jsonb arrays this won't compose perfectly; the dumped rows
    // we ship don't exercise that today (audit_log is excluded).
    if (v.length === 0) return "'{}'"
    return 'ARRAY[' + v.map((x) => quoteLiteral(x, false)).join(',') + ']'
  }
  if (typeof v === 'object') {
    // jsonb / json — serialise with escaped quotes
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'" + (isJsonbCol ? '::jsonb' : '::json')
  }
  // string
  return "'" + String(v).replace(/'/g, "''") + "'"
}

async function getColumns(schema, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  )
  return rows
}

console.log(`-- Local DB export (Tier 0, Node dumper) ${new Date().toISOString().slice(0, 10)}`)
console.log('-- Restore (Tier 0): node scripts/lib/restore-seed.mjs supabase/seed.sql')
console.log('')
console.log('SET session_replication_role = replica;')
console.log('')

let total = 0
for (const qualified of TABLES) {
  const [schema, table] = qualified.split('.')
  const cols = await getColumns(schema, table)
  if (cols.length === 0) {
    process.stderr.write(`skip ${qualified} (no columns / missing)\n`)
    continue
  }
  const colList = cols.map((c) => quoteIdent(c.column_name)).join(', ')
  const jsonbCols = new Set(cols.filter((c) => c.data_type === 'jsonb').map((c) => c.column_name))
  const { rows } = await client.query(`SELECT ${colList} FROM ${quoteIdent(schema)}.${quoteIdent(table)}`)
  for (const row of rows) {
    const vals = cols.map((c) => quoteLiteral(row[c.column_name], jsonbCols.has(c.column_name)))
    console.log(`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${colList}) VALUES (${vals.join(', ')});`)
  }
  total += rows.length
  process.stderr.write(`${qualified}: ${rows.length} rows\n`)
}

console.log('')
console.log('SET session_replication_role = DEFAULT;')

process.stderr.write(`total: ${total} rows\n`)
await client.end()
