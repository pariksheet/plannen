#!/usr/bin/env node
// Tier 2 step: copy every object in the Tier 1 (local Supabase Docker) storage
// bucket to the linked cloud Supabase project's storage bucket.
//
// Source-of-truth for the file list is the Tier 1 `storage.objects` table —
// it's authoritative and includes name, size, mimetype, owner. For each row:
//   1. HEAD on cloud → skip if already present (resumable across runs)
//   2. GET from source via Storage REST
//   3. POST to cloud via Storage REST (x-upsert: true)
//   4. Record success to .tier2-uploaded.txt
//
// Inputs (ctx):
//   ctx.tier1DatabaseUrl       — local Supabase pg (read storage.objects)
//   ctx.tier1StorageUrl        — e.g. http://127.0.0.1:54321
//   ctx.tier1ServiceRoleKey    — local service-role key
//   ctx.cloudSupabaseUrl       — e.g. https://<ref>.supabase.co
//   ctx.cloudServiceRoleKey    — cloud service-role key
//   ctx.bucket                 — default 'event-photos'
//   ctx.acceptStorageQuota     — bool; required when total > 1 GB
//   ctx.skipPhotos             — bool; short-circuit (count parity skipped)
//   ctx.checkpointPath         — default <repo>/.tier2-uploaded.txt
//   ctx.maxBytesBeforeWarn     — default 1 GB
// Outputs (added to ctx):
//   uploadedCount              — uploads that just ran
//   skippedCount               — already-present on cloud
//   totalSourceCount           — rows seen in tier1 storage.objects
//   totalSourceBytes
//
// All HTTP goes through deps.fetch so tests can stub it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const DEFAULT_CHECKPOINT = join(REPO_ROOT, '.tier2-uploaded.txt')
const ONE_GB = 1024 * 1024 * 1024

// Pure: human-friendly bytes formatter.
export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < ONE_GB) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / ONE_GB).toFixed(2)} GB`
}

// Pure: quota gating decision.
// Returns { warn: bool, blocked: bool, message: string }.
//   warn       — total exceeds the threshold; user should see a notice.
//   blocked    — total exceeds AND acceptStorageQuota is not set; abort.
export function quotaCheck(totalBytes, { maxBytesBeforeWarn = ONE_GB, acceptStorageQuota = false } = {}) {
  if (totalBytes <= maxBytesBeforeWarn) {
    return { warn: false, blocked: false, message: '' }
  }
  const human = formatBytes(totalBytes)
  if (acceptStorageQuota) {
    return {
      warn: true,
      blocked: false,
      message: `proceeding with ${human} (acceptStorageQuota set)`,
    }
  }
  return {
    warn: true,
    blocked: true,
    message: `photo bucket total ${human} exceeds free-tier (1 GB); re-run with --accept-storage-quota or --skip-photos`,
  }
}

// Pure: load the checkpoint file into a Set. Missing file → empty set.
export function readCheckpoint(path) {
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
}

// Pure: write a single line to the checkpoint (appending). Caller decides path.
export function recordCheckpoint(path, key) {
  const line = key.endsWith('\n') ? key : `${key}\n`
  if (existsSync(path)) {
    writeFileSync(path, readFileSync(path, 'utf8') + line)
  } else {
    writeFileSync(path, line)
  }
}

// IO: list source objects from Tier 1 storage.objects.
// Returns [{ name, size, mimetype, owner }, ...] sorted by name.
export async function listSourceObjects({ tier1DatabaseUrl, bucket = 'event-photos' }, { Client = pg.Client } = {}) {
  const client = new Client({ connectionString: tier1DatabaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query(
      `SELECT name,
              COALESCE((metadata->>'size')::bigint, 0)        AS size,
              COALESCE(metadata->>'mimetype', '')             AS mimetype,
              owner::text                                     AS owner
         FROM storage.objects
        WHERE bucket_id = $1
        ORDER BY name`,
      [bucket],
    )
    return rows.map((r) => ({
      name: r.name,
      size: Number(r.size),
      mimetype: r.mimetype || 'application/octet-stream',
      owner: r.owner,
    }))
  } finally {
    await client.end()
  }
}

// Pure: build the storage-REST URL for an object on a Supabase instance.
export function storageObjectUrl(baseUrl, bucket, path) {
  return `${baseUrl.replace(/\/+$/, '')}/storage/v1/object/${bucket}/${path}`
}

// IO: HEAD probe — does the object already exist on the destination?
export async function headCloud(url, serviceRoleKey, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(url, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
  })
  return res.status === 200
}

// IO: download bytes from the source. Throws on non-2xx.
export async function downloadFromSource(url, serviceRoleKey, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
  })
  if (!res.ok) {
    throw new Error(`source GET ${url} → HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

// IO: upload bytes to the destination. Throws on non-2xx.
export async function uploadToCloud(url, serviceRoleKey, body, mimetype, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`cloud POST ${url} → HTTP ${res.status}: ${text}`)
  }
}

// Pure: generic retry wrapper. Tests stub the delayer.
export async function withRetry(fn, { tries = 3, baseMs = 100, delay = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastErr = e
      if (attempt < tries - 1) {
        await delay(baseMs * Math.pow(2, attempt))
      }
    }
  }
  throw lastErr
}

// Top-level orchestrator.
export async function run(ctx = {}, deps = {}) {
  if (ctx.skipPhotos) {
    return { ...ctx, uploadedCount: 0, skippedCount: 0, totalSourceCount: 0, totalSourceBytes: 0 }
  }

  const required = ['tier1DatabaseUrl', 'tier1StorageUrl', 'tier1ServiceRoleKey', 'cloudSupabaseUrl', 'cloudServiceRoleKey']
  for (const k of required) {
    if (!ctx[k]) throw new Error(`storage-cloud-upload requires ctx.${k}`)
  }

  const bucket = ctx.bucket ?? 'event-photos'
  const checkpointPath = ctx.checkpointPath ?? DEFAULT_CHECKPOINT
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  const fetch = deps.fetch ?? globalThis.fetch
  const Client = deps.Client ?? pg.Client

  const objects = await listSourceObjects(
    { tier1DatabaseUrl: ctx.tier1DatabaseUrl, bucket },
    { Client },
  )
  const totalBytes = objects.reduce((acc, o) => acc + o.size, 0)

  const quota = quotaCheck(totalBytes, {
    maxBytesBeforeWarn: ctx.maxBytesBeforeWarn ?? ONE_GB,
    acceptStorageQuota: ctx.acceptStorageQuota === true,
  })
  if (quota.warn) log(`  ${quota.message}`)
  if (quota.blocked) throw new Error(quota.message)

  log(`  ${objects.length} object(s), ${formatBytes(totalBytes)} total`)

  const done = readCheckpoint(checkpointPath)
  let uploaded = 0
  let skipped = 0
  let i = 0

  for (const obj of objects) {
    i++
    const key = `${bucket}/${obj.name}`
    const sourceUrl = storageObjectUrl(ctx.tier1StorageUrl, bucket, obj.name)
    const cloudUrl = storageObjectUrl(ctx.cloudSupabaseUrl, bucket, obj.name)

    if (done.has(key)) {
      skipped++
      continue
    }

    // HEAD precheck — if already on cloud (e.g. previous run died after
    // upload but before checkpoint), record and skip.
    const onCloud = await withRetry(
      () => headCloud(cloudUrl, ctx.cloudServiceRoleKey, { fetch }),
      { tries: 3, baseMs: 100, delay: deps.delay },
    )
    if (onCloud) {
      recordCheckpoint(checkpointPath, key)
      skipped++
      continue
    }

    const body = await withRetry(
      () => downloadFromSource(sourceUrl, ctx.tier1ServiceRoleKey, { fetch }),
      { tries: 3, baseMs: 100, delay: deps.delay },
    )
    await withRetry(
      () => uploadToCloud(cloudUrl, ctx.cloudServiceRoleKey, body, obj.mimetype, { fetch }),
      { tries: 3, baseMs: 100, delay: deps.delay },
    )

    recordCheckpoint(checkpointPath, key)
    uploaded++
    if (i % 10 === 0) log(`  uploaded ${uploaded}/${objects.length}…`)
  }

  log(`  done: ${uploaded} uploaded, ${skipped} already-present`)

  return {
    ...ctx,
    uploadedCount: uploaded,
    skippedCount: skipped,
    totalSourceCount: objects.length,
    totalSourceBytes: totalBytes,
  }
}

// CLI entry — debugging / manual re-run.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = await run({
      tier1DatabaseUrl: process.env.DATABASE_URL_TIER1,
      tier1StorageUrl: process.env.TIER1_STORAGE_URL ?? 'http://127.0.0.1:54321',
      tier1ServiceRoleKey: process.env.TIER1_SERVICE_ROLE_KEY,
      cloudSupabaseUrl: process.env.CLOUD_SUPABASE_URL,
      cloudServiceRoleKey: process.env.CLOUD_SERVICE_ROLE_KEY,
      acceptStorageQuota: process.env.ACCEPT_STORAGE_QUOTA === '1',
    })
    process.stdout.write(
      `uploaded ${out.uploadedCount}, skipped ${out.skippedCount}, total ${out.totalSourceCount}\n`,
    )
  } catch (e) {
    process.stderr.write(`storage-cloud-upload failed: ${e.message}\n`)
    process.exit(1)
  }
}
