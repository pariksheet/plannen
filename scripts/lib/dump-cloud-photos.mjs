#!/usr/bin/env node
// Tier 2 → Tier 0 photo dumper. Pulls every object in the cloud Supabase
// `event-photos` bucket down to a local tarball that
// scripts/lib/restore-photos.mjs (Tier 0 path) can ingest.
//
// Source-of-truth for the file list is the cloud `storage.objects` table —
// authoritative, includes name. For each row we GET the object via Storage
// REST and stage it under `event-photos/<name>` in a temp dir, then tar it.
//
// Inputs (env / argv):
//   DATABASE_URL                  — full cloud Postgres URL (with password)
//   SUPABASE_URL                  — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     — cloud service-role key
//   argv[2]                       — output tarball path
//
// All HTTP goes through deps.fetch so tests can stub it.

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Pure: build the Storage REST URL for a single object download.
// Path segments are URI-encoded individually so '/' separators survive.
export function storageObjectUrl(supabaseUrl, bucket, name) {
  const base = supabaseUrl.replace(/\/+$/, '')
  const encoded = name.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/${bucket}/${encoded}`
}

// Pure: parse a `storage.objects` row into the local relative path we stage at.
// Mirrors the layout that `restore-photos.mjs` (Tier 0) expects, namely
// `<bucket>/<name>` flat — no version-uuid subdir.
export function stagePathFor(bucket, name) {
  return `${bucket}/${name}`
}

export async function listCloudObjects(databaseUrl, bucket, { ClientCtor = pg.Client } = {}) {
  const client = new ClientCtor({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query(
      "SELECT name FROM storage.objects WHERE bucket_id = $1 ORDER BY name",
      [bucket],
    )
    return rows.map((r) => r.name)
  } finally {
    await client.end()
  }
}

export async function downloadObject({ supabaseUrl, bucket, name, serviceRoleKey, fetchImpl }) {
  const url = storageObjectUrl(supabaseUrl, bucket, name)
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  })
  if (!res.ok) {
    throw new Error(`download ${name}: ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

export async function run(ctx, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch
  const log = deps.log ?? ((msg) => process.stderr.write(msg))
  const bucket = ctx.bucket ?? 'event-photos'
  const names = await listCloudObjects(ctx.databaseUrl, bucket, deps)
  if (names.length === 0) {
    log(`No objects in bucket '${bucket}' — skipping tarball.\n`)
    return { count: 0, tarPath: null }
  }

  const stage = deps.mkStage ? deps.mkStage() : mkdtempSync(join(tmpdir(), 'plannen-cloud-photos-'))
  log(`Downloading ${names.length} objects from ${bucket}...\n`)

  let ok = 0
  let failed = 0
  for (const name of names) {
    try {
      const buf = await downloadObject({
        supabaseUrl: ctx.supabaseUrl,
        bucket,
        name,
        serviceRoleKey: ctx.serviceRoleKey,
        fetchImpl,
      })
      const rel = stagePathFor(bucket, name)
      const dest = join(stage, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, buf)
      ok++
      if (ok % 25 === 0) log(`  ${ok}/${names.length}\n`)
    } catch (e) {
      failed++
      log(`  ${name}: ${e.message} — skipping\n`)
    }
  }
  log(`  ${ok}/${names.length} downloaded (${failed} failed)\n`)

  log(`Creating tarball ${ctx.outPath}...\n`)
  const tarFn = deps.tar ?? ((args) => execSync(args, { stdio: 'inherit' }))
  tarFn(`tar czf "${ctx.outPath}" -C "${stage}" "${bucket}"`)
  if (!deps.keepStage) rmSync(stage, { recursive: true, force: true })

  return { count: ok, failed, tarPath: ctx.outPath }
}

// CLI entry — skip when imported by tests.
const IS_DIRECT = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (IS_DIRECT) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: dump-cloud-photos.mjs <out.tar.gz>')
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
    console.error('DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required')
    process.exit(1)
  }
  const result = await run({ databaseUrl, supabaseUrl, serviceRoleKey, outPath: out })
  process.stderr.write(`Done. ${result.count} files in ${result.tarPath ?? '(none)'}\n`)
}
