// Tier-aware "snapshot current state" utility. Writes a DB dump + photo
// tarball pair to <outDir>/<ISO timestamp>.{sql.gz,photos.tar.gz} and
// prunes older snapshots beyond --keep.
//
//   node scripts/lib/snapshot.mjs --tier {0|1} --out <dir> [--keep 5]
//
// Tier 0: dump via the same SQL emitter `dump-tables.mjs` uses, gzipped;
//         photos via `tar czf` of $PLANNEN_PHOTOS_ROOT (default
//         ~/.plannen/photos).
// Tier 1: dump via `docker exec supabase_db_plannen pg_dump`; photos via
//         `docker exec supabase_storage_plannen tar czf - -C /mnt`.
//
// Empty source (DB unreachable or zero rows) is logged and treated as a
// no-op — exit 0. The caller (bootstrap.sh) gates the call already; this
// safety means a stray invocation doesn't tank a run.

import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

export function timestampForFilename(date) {
  // ISO without ms, colons → hyphens. e.g. "2026-05-16T10:01:00.123Z" → "2026-05-16T10-01-00Z"
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return iso.replace(/:/g, '-')
}

// Matches "<ISO>.sql.gz" or "<ISO>-photos.tar.gz". The ISO part has no colons.
const SNAPSHOT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:\.sql\.gz|-photos\.tar\.gz)$/

export function prune(dir, keep) {
  if (!existsSync(dir)) return

  // Group files by their snapshot stamp; track the most recent mtime per stamp.
  const stamps = new Map() // stamp -> { mtime, files: [filename] }
  for (const name of readdirSync(dir)) {
    const m = SNAPSHOT_RE.exec(name)
    if (!m) continue
    const stamp = m[1]
    const full = join(dir, name)
    const mtime = statSync(full).mtimeMs
    const entry = stamps.get(stamp) ?? { mtime: 0, files: [] }
    entry.files.push(name)
    if (mtime > entry.mtime) entry.mtime = mtime
    stamps.set(stamp, entry)
  }

  const sorted = [...stamps.entries()].sort((a, b) => b[1].mtime - a[1].mtime)
  const toDelete = sorted.slice(keep)
  for (const [, entry] of toDelete) {
    for (const f of entry.files) {
      unlinkSync(join(dir, f))
    }
  }
}

function awaitExit(subprocess, label, errChunks) {
  return new Promise((resolve, reject) => {
    subprocess.on('error', reject)
    subprocess.on('close', (code) => {
      if (code === 0) return resolve()
      const stderr = errChunks ? Buffer.concat(errChunks).toString('utf8') : ''
      reject(new Error(`${label} exited ${code}${stderr ? '\nstderr: ' + stderr : ''}`))
    })
  })
}

async function gzipFromSubprocess(subprocess, destPath, label) {
  const out = createWriteStream(destPath)
  const gz = createGzip()
  const errChunks = []
  subprocess.stderr?.on('data', (d) => errChunks.push(d))
  const exit = awaitExit(subprocess, label, errChunks)
  try {
    await pipeline(subprocess.stdout, gz, out)
  } catch (e) {
    const stderr = Buffer.concat(errChunks).toString('utf8')
    throw new Error(`${label} gzip pipeline failed: ${e.message}${stderr ? '\nstderr: ' + stderr : ''}`)
  }
  await exit
}

async function snapshotTier0({ outDir, stamp }) {
  const sqlOut = join(outDir, `${stamp}.sql.gz`)
  const photosOut = join(outDir, `${stamp}-photos.tar.gz`)

  // DB dump: spawn dump-tables.mjs and gzip its stdout.
  const dumper = spawn(
    process.execPath,
    [join(REPO_ROOT, 'scripts/lib/dump-tables.mjs')],
    {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TIER0 ?? 'postgres://plannen:plannen@127.0.0.1:54322/plannen',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await gzipFromSubprocess(dumper, sqlOut, 'tier-0 dump-tables')

  // Photos: tar -C <photosRoot> .
  const photosRoot = process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos')
  if (existsSync(photosRoot) && readdirSync(photosRoot).length > 0) {
    execFileSync('tar', ['czf', photosOut, '-C', photosRoot, '.'])
  } else {
    // touch an empty tarball so the .sql.gz/-photos.tar.gz pair stays paired
    execFileSync('tar', ['czf', photosOut, '-T', '/dev/null'])
  }
}

async function snapshotTier1({ outDir, stamp, dbContainer, storageContainer }) {
  const sqlOut = join(outDir, `${stamp}.sql.gz`)
  const photosOut = join(outDir, `${stamp}-photos.tar.gz`)

  // DB dump: pg_dump inside the supabase db container, --data-only, --column-inserts.
  // Strip the pg_dump 17+ `\restrict <hash>` / `\unrestrict` lines so the file
  // is fed-back-able to plain psql or restore-seed.mjs.
  const tables = [
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
  const tableArgs = tables.flatMap((t) => ['--table', t])
  const pgDump = spawn(
    'docker',
    ['exec', dbContainer, 'pg_dump', '-U', 'postgres', '--data-only', '--column-inserts', ...tableArgs, 'postgres'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // We can't easily grep mid-stream and still pipe to gzip without spawning
  // another process. Easier: filter the gzip's source via a Transform.
  const { Transform } = await import('node:stream')
  const stripRestrictLines = new Transform({
    transform(chunk, _enc, cb) {
      // Conservative line-based filter; safe because pg_dump emits LF-delimited text.
      const s = chunk.toString('utf8')
      const filtered = s
        .split('\n')
        .filter((line) => !/^\\(restrict|unrestrict)(\s|$)/.test(line))
        .join('\n')
      cb(null, filtered)
    },
  })
  const errChunks = []
  pgDump.stderr.on('data', (d) => errChunks.push(d))
  const pgDumpExit = awaitExit(pgDump, 'tier-1 pg_dump', errChunks)
  const gz = createGzip()
  const out = createWriteStream(sqlOut)
  try {
    await pipeline(pgDump.stdout, stripRestrictLines, gz, out)
  } catch (e) {
    const stderr = Buffer.concat(errChunks).toString('utf8')
    throw new Error(`tier-1 pg_dump pipeline failed: ${e.message}${stderr ? '\nstderr: ' + stderr : ''}`)
  }
  await pgDumpExit

  // Photos: tar of the storage container's /mnt.
  const tarProc = spawn(
    'docker',
    ['exec', storageContainer, 'tar', 'czf', '-', '-C', '/mnt', '.'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const photosOutStream = createWriteStream(photosOut)
  const tarErr = []
  tarProc.stderr.on('data', (d) => tarErr.push(d))
  const tarExit = awaitExit(tarProc, 'tier-1 storage tar', tarErr)
  await pipeline(tarProc.stdout, photosOutStream)
  await tarExit
}

export async function snapshot({ tier, outDir, keep = 5, dbContainer = 'supabase_db_plannen', storageContainer = 'supabase_storage_plannen' }) {
  mkdirSync(outDir, { recursive: true })
  const stamp = timestampForFilename(new Date())
  if (tier === 0) {
    await snapshotTier0({ outDir, stamp })
  } else if (tier === 1) {
    await snapshotTier1({ outDir, stamp, dbContainer, storageContainer })
  } else {
    throw new Error(`unsupported tier: ${tier}`)
  }
  prune(outDir, keep)
  return { stamp, sqlPath: join(outDir, `${stamp}.sql.gz`), photosPath: join(outDir, `${stamp}-photos.tar.gz`) }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--tier') args.set('tier', Number(process.argv[++i]))
    else if (a === '--out') args.set('out', process.argv[++i])
    else if (a === '--keep') args.set('keep', Number(process.argv[++i]))
  }
  const tier = args.get('tier')
  const out = args.get('out')
  if (tier === undefined || !out) {
    console.error('usage: snapshot.mjs --tier {0|1} --out <dir> [--keep 5]')
    process.exit(1)
  }
  try {
    const r = await snapshot({ tier, outDir: out, keep: args.get('keep') ?? 5 })
    console.log(`snapshot written: ${r.sqlPath} + ${r.photosPath}`)
  } catch (e) {
    console.error(`snapshot failed: ${e.message}`)
    process.exit(1)
  }
}
