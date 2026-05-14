#!/usr/bin/env node
// Restore a Tier 1 seed dump (supabase/seed.sql) into Tier 0 embedded Postgres.
//
//   node scripts/lib/restore-seed.mjs <path-to-seed.sql>
//
// 1. Wipes existing plannen.* + auth.users data.
// 2. Extends Tier 0's stub auth.users with the columns Supabase Auth uses
//    (nullable) so the dump's INSERTs land cleanly.
// 3. Executes seed.sql in a single connection with session_replication_role=replica
//    (triggers + FKs deferred — matches Supabase's restore semantics).
//
// After this the bootstrap-created user is gone; the user(s) from the seed are
// active. Make sure .env's PLANNEN_USER_EMAIL matches an email that exists in
// the seed before starting the backend.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

try {
  const { config } = await import('dotenv')
  config({ path: join(REPO_ROOT, '.env') })
} catch { /* dotenv missing — rely on env */ }

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const seedPath = process.argv[2]
if (!seedPath) {
  console.error('usage: restore-seed.mjs <path-to-seed.sql>')
  process.exit(1)
}
const seed = readFileSync(seedPath, 'utf8')

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

console.log('1/4 wiping existing plannen.* and auth.users data...')
await client.query(`
  SET session_replication_role = replica;
  TRUNCATE TABLE
    plannen.audit_log,
    plannen.profile_facts,
    plannen.story_events,
    plannen.stories,
    plannen.event_source_refs,
    plannen.event_sources,
    plannen.event_memories,
    plannen.event_rsvps,
    plannen.event_shared_with_groups,
    plannen.event_shared_with_users,
    plannen.event_invites,
    plannen.events,
    plannen.family_members,
    plannen.relationships,
    plannen.friend_group_members,
    plannen.friend_groups,
    plannen.user_locations,
    plannen.user_oauth_tokens,
    plannen.user_settings,
    plannen.user_profiles,
    plannen.users,
    plannen.agent_tasks,
    plannen.app_allowed_emails,
    plannen.oauth_state
  RESTART IDENTITY CASCADE;
  DELETE FROM auth.users;
  SET session_replication_role = origin;
`)

console.log('2/4 extending auth.users with Supabase Auth columns (nullable)...')
// Tier 0 stub has (id, email, raw_user_meta_data, created_at). The dump's
// INSERT lists 34 columns. Add the missing ones as nullable so the dump fits.
await client.query(`
  ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS instance_id uuid,
    ADD COLUMN IF NOT EXISTS aud text,
    ADD COLUMN IF NOT EXISTS role text,
    ADD COLUMN IF NOT EXISTS encrypted_password text,
    ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS invited_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmation_token text,
    ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS recovery_token text,
    ADD COLUMN IF NOT EXISTS recovery_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS email_change_token_new text,
    ADD COLUMN IF NOT EXISTS email_change text,
    ADD COLUMN IF NOT EXISTS email_change_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz,
    ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb,
    ADD COLUMN IF NOT EXISTS is_super_admin boolean,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS phone text,
    ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS phone_change text,
    ADD COLUMN IF NOT EXISTS phone_change_token text,
    ADD COLUMN IF NOT EXISTS phone_change_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS email_change_token_current text,
    ADD COLUMN IF NOT EXISTS email_change_confirm_status smallint,
    ADD COLUMN IF NOT EXISTS banned_until timestamptz,
    ADD COLUMN IF NOT EXISTS reauthentication_token text,
    ADD COLUMN IF NOT EXISTS reauthentication_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_sso_user boolean,
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_anonymous boolean
  ;
`)

console.log('3/4 applying seed.sql...')
// pg-node supports multi-statement queries in a single .query() call. The
// dump opens with SET session_replication_role = replica so triggers + FKs
// stay deferred for the whole file. seed.sql is ~530 SQL statements; this
// loads in one round-trip.
try {
  await client.query(seed)
} catch (e) {
  console.error('seed apply FAILED:', e.message)
  if (e.where) console.error(' at:', e.where)
  process.exit(1)
}

console.log('4/4 verifying...')
const { rows: counts } = await client.query(`
  SELECT
    (SELECT count(*) FROM auth.users) AS auth_users,
    (SELECT count(*) FROM plannen.users) AS plannen_users,
    (SELECT count(*) FROM plannen.events) AS events,
    (SELECT count(*) FROM plannen.event_memories) AS memories,
    (SELECT count(*) FROM plannen.stories) AS stories
`)
console.log('counts:', counts[0])
await client.end()
console.log('done.')
