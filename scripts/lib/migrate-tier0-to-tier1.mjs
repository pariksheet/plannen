#!/usr/bin/env node
// Migrate user data from Tier 0 (embedded Postgres + flat photo dir) into
// Tier 1 (Supabase Docker stack). Idempotent: clears Tier 1 first, so
// repeated runs converge on the same end state.
//
// Preconditions:
//   - Tier 0 Postgres reachable at $DATABASE_URL_TIER0
//   - Tier 1 Supabase stack up; migrations applied; auth.users row for
//     the user is OK to be deleted (this migrator TRUNCATEs first).
//   - Tier 0 photos at $PLANNEN_PHOTOS_ROOT (default ~/.plannen/photos)
//
// Env:
//   DATABASE_URL_TIER0   — required
//   DATABASE_URL_TIER1   — required
//   PLANNEN_PHOTOS_ROOT  — optional, defaults to ~/.plannen/photos
//   STORAGE_CONTAINER    — optional, defaults to supabase_storage_plannen
//   STORAGE_HOST_URL     — optional, defaults to http://127.0.0.1:54321 (used
//                          to rewrite relative media_url paths to absolute)
//
// Steps:
//   1. Dump Tier 0 (spawn dump-tables.mjs, capture stdout)
//   2. Walk Tier 0 photos to build inventory (path, size, etag, owner, ...)
//   3. TRUNCATE Tier 1 plannen.* + auth.users
//   4. Apply Tier 0 dump to Tier 1 (session_replication_role=replica)
//   5. Rewrite media_url paths to absolute http://127.0.0.1:54321/...
//   6. Synthesize + INSERT storage.objects rows
//   7. docker cp staged photos into supabase_storage_plannen:/mnt/
//   8. Verify counts match between source and destination

import { spawn, execFileSync } from 'node:child_process'
import { readdirSync, statSync, readFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import pg from 'pg'

import { synthesize } from './storage-objects.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

// Map file extensions to MIME types.
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

export function mimeFromPath(filename) {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

// Walk a bucket root flatly: <root>/<bucket>/<event>/<owner>/<filename>.
// Returns inventory entries ready for storage-objects.synthesize().
export function inventoryPhotos(photosRoot) {
  const out = []
  if (!existsSync(photosRoot)) return out

  for (const bucket of readdirSync(photosRoot)) {
    const bucketAbs = join(photosRoot, bucket)
    if (!statSync(bucketAbs).isDirectory()) continue
    if (bucket !== 'event-photos') continue // only photos bucket today

    for (const eventId of readdirSync(bucketAbs)) {
      const eventAbs = join(bucketAbs, eventId)
      if (!statSync(eventAbs).isDirectory()) continue

      for (const ownerId of readdirSync(eventAbs)) {
        const ownerAbs = join(eventAbs, ownerId)
        if (!statSync(ownerAbs).isDirectory()) continue

        for (const filename of readdirSync(ownerAbs)) {
          const fileAbs = join(ownerAbs, filename)
          const st = statSync(fileAbs)
          if (!st.isFile()) continue

          const buf = readFileSync(fileAbs)
          const etag = createHash('md5').update(buf).digest('hex')

          out.push({
            bucket,
            path: `${eventId}/${ownerId}/${filename}`,
            srcAbsPath: fileAbs,
            size: st.size,
            mimetype: mimeFromPath(filename),
            owner: ownerId, // owner is the second path component
            etag,
            lastModified: new Date(st.mtimeMs).toISOString(),
          })
        }
      }
    }
  }

  return out
}

// Capture dump-tables.mjs stdout as a string.
function dumpTier0(databaseUrlTier0) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const errChunks = []
    const proc = spawn(
      process.execPath,
      [join(REPO_ROOT, 'scripts/lib/dump-tables.mjs')],
      {
        env: { ...process.env, DATABASE_URL: databaseUrlTier0 },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => errChunks.push(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(new Error(`dump-tables exited ${code}\nstderr: ${Buffer.concat(errChunks).toString('utf8')}`))
      }
    })
  })
}

const TRUNCATE_TABLES = [
  'plannen.audit_log',
  'plannen.profile_facts',
  'plannen.story_events',
  'plannen.stories',
  'plannen.event_source_refs',
  'plannen.event_sources',
  'plannen.event_memories',
  'plannen.event_rsvps',
  'plannen.event_shared_with_groups',
  'plannen.event_shared_with_users',
  'plannen.event_invites',
  'plannen.events',
  'plannen.family_members',
  'plannen.relationships',
  'plannen.friend_group_members',
  'plannen.friend_groups',
  'plannen.user_locations',
  'plannen.user_oauth_tokens',
  'plannen.user_settings',
  'plannen.user_profiles',
  'plannen.users',
  'plannen.agent_tasks',
  'plannen.app_allowed_emails',
  'plannen.oauth_state',
]

async function truncateTier1(client) {
  await client.query('BEGIN')
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(`TRUNCATE TABLE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  await client.query('DELETE FROM storage.objects WHERE bucket_id = $1', ['event-photos'])
  await client.query('DELETE FROM auth.users')
  await client.query('COMMIT')
}

async function applyDump(client, dumpSql) {
  // The dump opens with `SET session_replication_role = replica;` so triggers
  // and FKs stay deferred for the whole load. It closes with `SET ... = DEFAULT;`
  // pg-node accepts multi-statement strings via query().
  await client.query(dumpSql)
}

async function rewriteMediaUrls(client, storageHostUrl) {
  // Tier 0 had host-stripped relative URLs (/storage/v1/...). Tier 1 needs
  // absolute URLs against the local Supabase storage endpoint.
  for (const [table, col] of [
    ['plannen.event_memories', 'media_url'],
    ['plannen.events', 'image_url'],
    ['plannen.stories', 'cover_url'],
  ]) {
    await client.query(
      `UPDATE ${table} SET ${col} = $1 || ${col} WHERE ${col} LIKE '/storage/v1/%'`,
      [storageHostUrl],
    )
  }
}

async function insertStorageObjects(client, rows) {
  if (rows.length === 0) return
  // Insert one row at a time. The volume is small (single-user app) and the
  // simpler code is worth the small perf cost.
  for (const r of rows) {
    await client.query(
      `INSERT INTO storage.objects
        (id, bucket_id, name, owner, owner_id, created_at, updated_at, last_accessed_at, metadata, version, user_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)`,
      [
        r.id,
        r.bucket_id,
        r.name,
        r.owner,
        r.owner_id,
        r.created_at,
        r.updated_at,
        r.last_accessed_at,
        JSON.stringify(r.metadata),
        r.version,
        JSON.stringify(r.user_metadata),
      ],
    )
  }
}

function copyPhotosIntoContainer(layout, storageContainer) {
  if (layout.length === 0) return
  const stage = mkdtempSync(join(tmpdir(), 'plannen-migrate-'))
  try {
    for (const { srcAbsPath, destRelPath } of layout) {
      const destAbs = join(stage, destRelPath)
      mkdirSync(dirname(destAbs), { recursive: true })
      copyFileSync(srcAbsPath, destAbs)
    }
    // `docker cp <stage>/. <container>:/mnt/` merges contents into /mnt.
    execFileSync('docker', ['cp', `${stage}/.`, `${storageContainer}:/mnt/`])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

async function verify(tier0Client, tier1Client) {
  const tables = [
    'plannen.events',
    'plannen.event_memories',
    'plannen.event_sources',
    'plannen.family_members',
    'plannen.profile_facts',
    'plannen.stories',
  ]
  const mismatches = []
  for (const t of tables) {
    const { rows: s } = await tier0Client.query(`SELECT count(*)::int AS n FROM ${t}`)
    const { rows: d } = await tier1Client.query(`SELECT count(*)::int AS n FROM ${t}`)
    if (s[0].n !== d[0].n) {
      mismatches.push(`${t}: source=${s[0].n}, dest=${d[0].n}`)
    }
  }
  // storage.objects only exists in Tier 1; the source is the photo file count.
  return mismatches
}

export async function migrate({
  databaseUrlTier0,
  databaseUrlTier1,
  photosRoot = process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'),
  storageContainer = process.env.STORAGE_CONTAINER ?? 'supabase_storage_plannen',
  storageHostUrl = process.env.STORAGE_HOST_URL ?? 'http://127.0.0.1:54321',
} = {}) {
  if (!databaseUrlTier0) throw new Error('databaseUrlTier0 is required')
  if (!databaseUrlTier1) throw new Error('databaseUrlTier1 is required')

  process.stderr.write('1/8 dumping Tier 0...\n')
  const dumpSql = await dumpTier0(databaseUrlTier0)

  process.stderr.write('2/8 inventorying Tier 0 photos...\n')
  const inventory = inventoryPhotos(photosRoot)
  process.stderr.write(`    ${inventory.length} photo(s) found\n`)

  const tier1 = new pg.Client({ connectionString: databaseUrlTier1 })
  await tier1.connect()
  const tier0 = new pg.Client({ connectionString: databaseUrlTier0 })
  await tier0.connect()

  try {
    process.stderr.write('3/8 TRUNCATE Tier 1 plannen.* + auth.users + storage.objects...\n')
    await truncateTier1(tier1)

    process.stderr.write('4/8 applying Tier 0 dump...\n')
    await applyDump(tier1, dumpSql)

    process.stderr.write('5/8 rewriting media_url to absolute...\n')
    await rewriteMediaUrls(tier1, storageHostUrl)

    process.stderr.write('6/8 synthesizing storage.objects rows...\n')
    const { rows: objectRows, layout } = synthesize(inventory)
    await insertStorageObjects(tier1, objectRows)
    process.stderr.write(`    inserted ${objectRows.length} row(s)\n`)

    process.stderr.write('7/8 copying photos into storage container...\n')
    copyPhotosIntoContainer(layout, storageContainer)

    process.stderr.write('8/8 verifying counts...\n')
    const mismatches = await verify(tier0, tier1)
    if (mismatches.length > 0) {
      throw new Error(`count mismatch after migration:\n  ${mismatches.join('\n  ')}`)
    }

    process.stderr.write('migration complete.\n')
    return { photoCount: inventory.length, storageObjectCount: objectRows.length }
  } finally {
    await tier0.end()
    await tier1.end()
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrlTier0 = process.env.DATABASE_URL_TIER0
  const databaseUrlTier1 = process.env.DATABASE_URL_TIER1
  if (!databaseUrlTier0 || !databaseUrlTier1) {
    console.error('DATABASE_URL_TIER0 and DATABASE_URL_TIER1 are required')
    process.exit(1)
  }
  try {
    const r = await migrate({ databaseUrlTier0, databaseUrlTier1 })
    console.log(`migrated: ${r.photoCount} photos, ${r.storageObjectCount} storage.objects rows`)
  } catch (e) {
    console.error(`migration failed: ${e.message}`)
    process.exit(1)
  }
}
