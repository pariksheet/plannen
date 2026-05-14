#!/usr/bin/env node
// Restore the seed-photos tarball into Tier 0's photo dir.
//
//   node scripts/lib/restore-photos.mjs <path-to-seed-photos.tar.gz>
//
// The Supabase storage dump nests each file as
//   bucket/<path>/<filename.jpg>/<version-uuid>
// (Storage versions each object). Tier 0 stores files flat:
//   bucket/<path>/<filename.jpg>
// This script extracts the tar to a tmp dir, then flattens by
// renaming each <filename>/<version-uuid> → <filename>.

import { execSync } from 'node:child_process'
import { readdirSync, statSync, renameSync, rmSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const archive = process.argv[2]
if (!archive) {
  console.error('usage: restore-photos.mjs <seed-photos.tar.gz>')
  process.exit(1)
}

const PHOTOS_ROOT = process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos')
const stage = mkdtempSync(join(tmpdir(), 'plannen-photos-'))

console.log(`1/3 extracting ${archive} → ${stage}`)
execSync(`tar xzf "${archive}" -C "${stage}"`, { stdio: 'inherit' })

// Supabase dump prefixes with ./stub/stub/event-photos/. Find the bucket dir.
let bucketRoot = stage
for (const candidate of ['stub/stub/event-photos', 'stub/event-photos', 'event-photos']) {
  const p = join(stage, candidate)
  try {
    if (statSync(p).isDirectory()) { bucketRoot = p; break }
  } catch { /* not this path */ }
}

const target = join(PHOTOS_ROOT, 'event-photos')
console.log(`2/3 copying ${bucketRoot} → ${target}`)
mkdirSync(target, { recursive: true })
cpSync(bucketRoot, target, { recursive: true })
rmSync(stage, { recursive: true, force: true })

console.log(`3/3 flattening Supabase version dirs (file/uuid → file)`)
let flattened = 0
function flatten(dir, depthFromBucket) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (depthFromBucket >= 3) {
      // depthFromBucket 3 = <event>/<user>/<filename> — should be a file but is a dir
      const inner = readdirSync(full)
      if (inner.length === 1 && statSync(join(full, inner[0])).isFile()) {
        const innerFile = join(full, inner[0])
        const tmp = `${full}.tmp`
        renameSync(innerFile, tmp)
        rmSync(full, { recursive: true })
        renameSync(tmp, full)
        flattened++
      }
    } else {
      flatten(full, depthFromBucket + 1)
    }
  }
}
flatten(target, 1)
console.log(`done — flattened ${flattened} version dirs.`)
