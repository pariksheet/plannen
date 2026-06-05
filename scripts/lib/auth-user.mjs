#!/usr/bin/env node
// Resolve or create a Plannen auth.users row. Uses @supabase/supabase-js from
// the repo root's node_modules. Invoked by scripts/bootstrap.sh.
//
//   node scripts/lib/auth-user.mjs <email>
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Exits 0 on success and prints the user UUID on stdout.
// Exits 2 with an abort message if a different user already exists
//   (single-user-per-instance constraint).
// Exits 1 on any other failure.

import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
if (args.length !== 1) {
  console.error('Usage: node scripts/lib/auth-user.mjs <email>')
  process.exit(1)
}

const email = args[0].trim().toLowerCase()
if (!email) {
  console.error('email is empty')
  process.exit(1)
}

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } })

let listed
try {
  listed = await db.auth.admin.listUsers()
} catch (e) {
  console.error(`Couldn't reach Supabase admin API: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
if (listed.error) {
  console.error(`admin.listUsers error: ${listed.error.message}`)
  process.exit(1)
}

const users = listed.data?.users ?? []
const match = users.find((u) => (u.email ?? '').toLowerCase() === email)

if (match) {
  console.log(match.id)
  process.exit(0)
}

if (users.length > 0) {
  const existing = users[0].email ?? '(no email)'
  console.error('')
  console.error(`There is already a Plannen user with email ${existing}.`)
  console.error('Single-user-per-instance is V1\'s design.')
  console.error('')
  console.error('Options:')
  console.error(`  1. Edit .env to use ${existing}, then re-run bootstrap.`)
  console.error('  2. Wipe the local DB and start over:')
  console.error('       bash scripts/export-seed.sh   # backup first')
  console.error('       supabase db reset')
  console.error('       bash scripts/bootstrap.sh')
  console.error('')
  process.exit(2)
}

// Empty auth.users — safe to create the user fresh.
const created = await db.auth.admin.createUser({ email, email_confirm: true })
if (created.error) {
  console.error(`createUser error: ${created.error.message}`)
  process.exit(1)
}
const id = created.data?.user?.id
if (!id) {
  console.error('createUser succeeded but returned no UUID')
  process.exit(1)
}
console.log(id)
process.exit(0)
