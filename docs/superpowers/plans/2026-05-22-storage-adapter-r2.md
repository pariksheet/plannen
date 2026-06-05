# Storage Adapter (R2 / S3-compatible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-profile `PLANNEN_STORAGE_BACKEND` knob (`local-fs` | `supabase` | `s3`) so any Tier 1/2 deployer can flip photo storage onto an S3-compatible bucket (Cloudflare R2, Tigris, B2, MinIO) without changing tier, while preserving the existing default behaviour for every current deployment.

**Architecture:** A small `StorageAdapter` interface (`upload`, `delete`, `signedUrl`, `head`) with three implementations behind a factory that reads the env once at boot. The Tier-0 Hono mirror route delegates to the `local-fs` adapter; the Tier-1 picker handler and a new `/api/photos/*` route delegate to whichever adapter the factory returns; a thin frontend `storageClient` hides backend choice from UI code. A one-shot CLI command (`plannen storage migrate`) copies bytes between backends without rewriting DB rows — keys are stored without a backend prefix so a migration is a copy, not a row rewrite.

**Tech Stack:** TypeScript · Hono (`backend/src/`) · `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (new) · Supabase Storage REST API (no new dep) · vitest · React (`src/`) · Node CLI (`cli/`)

**Spec:** [`docs/superpowers/specs/2026-05-21-storage-adapter-r2-design.md`](../specs/2026-05-21-storage-adapter-r2-design.md)

---

## Phase 0 — Schema & Foundation

### Task 1: Add `storage_key` column to `event_memories`

The spec defines a canonical key shape (`<user_id>/<event_id>/<uuid>.<ext>`) stored without a backend prefix. Today `event_memories` stores only `media_url` (a full publicUrl that bakes in the backend). We add a nullable `storage_key text` column and backfill from `media_url` so future code reads/writes the key and treats `media_url` as a cached convenience.

**Files:**
- Create: `supabase/migrations/20260522100000_event_memories_storage_key.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Storage adapter prep: canonical key column on event_memories.
-- Forward-only additive migration. storage_key is the backend-agnostic
-- identifier; media_url stays as a cached publicUrl for backward compat.
--
-- Key shape: <user_id>/<event_id>/<uuid>.<ext> with NO bucket prefix.

ALTER TABLE plannen.event_memories
  ADD COLUMN IF NOT EXISTS storage_key text;

COMMENT ON COLUMN plannen.event_memories.storage_key IS
  'Backend-agnostic object key under the event-photos bucket. Shape: <user_id>/<event_id>/<uuid>.<ext>. NULL for legacy rows that pre-date the storage adapter; resolve those via media_url.';

-- Backfill: strip the publicUrl prefix to recover the key.
-- Handles both Tier 0 (/storage/v1/object/public/event-photos/<key>) and
-- Tier 1/2 (<SUPABASE_URL>/storage/v1/object/public/event-photos/<key>).
UPDATE plannen.event_memories
SET storage_key = substring(media_url FROM '/storage/v1/object/public/event-photos/(.*)$')
WHERE storage_key IS NULL
  AND media_url IS NOT NULL
  AND media_url LIKE '%/storage/v1/object/public/event-photos/%';

CREATE INDEX IF NOT EXISTS event_memories_storage_key_idx
  ON plannen.event_memories (storage_key)
  WHERE storage_key IS NOT NULL;
```

- [ ] **Step 2: Apply the migration on a Tier 0 profile**

Run: `npx plannen migrate`
Expected: `applied 20260522100000_event_memories_storage_key`

- [ ] **Step 3: Verify backfill on existing rows**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE storage_key IS NOT NULL) AS with_key, count(*) FILTER (WHERE storage_key IS NULL AND media_url IS NOT NULL) AS legacy, count(*) AS total FROM plannen.event_memories;"
```
Expected: `with_key` ≥ all rows whose `media_url` is a Supabase-shaped URL; `legacy` only contains rows with non-storage URLs (e.g. Google Drive proxies).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260522100000_event_memories_storage_key.sql
git commit -m "feat(storage): add storage_key column to event_memories"
```

---

### Task 2: Define the StorageAdapter interface

A single TypeScript module describes the contract. No implementation yet — the failing test asserts the contract surface.

**Files:**
- Create: `backend/src/_shared/storage/adapter.ts`
- Create: `backend/src/_shared/storage/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/_shared/storage/adapter.test.ts
import { describe, it, expect } from 'vitest'
import type { StorageAdapter } from './adapter.js'

describe('StorageAdapter contract', () => {
  it('declares the four required methods', () => {
    // Compile-time check: this file fails to type-check if the methods
    // are missing or renamed. The runtime assertion below catches
    // accidental removal of the type export itself.
    const stub: StorageAdapter = {
      upload: async () => {},
      delete: async () => false,
      signedUrl: async () => '',
      head: async () => null,
    }
    expect(typeof stub.upload).toBe('function')
    expect(typeof stub.delete).toBe('function')
    expect(typeof stub.signedUrl).toBe('function')
    expect(typeof stub.head).toBe('function')
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL: module not found)**

Run: `cd backend && npm test -- adapter.test`
Expected: FAIL with "Cannot find module './adapter.js'"

- [ ] **Step 3: Write the interface**

```ts
// backend/src/_shared/storage/adapter.ts
//
// Backend-agnostic object-storage contract. Three implementations live
// alongside (localFs, supabase, s3); the factory picks one at boot based
// on PLANNEN_STORAGE_BACKEND. Keys are canonical and contain no backend
// prefix (no leading "event-photos/"); each adapter prepends its own.

export interface UploadOptions {
  contentType: string
  /** Defaults to 'private, max-age=3600' when omitted. */
  cacheControl?: string
}

export interface SignedUrlOptions {
  /** 60..86400 seconds. */
  ttlSeconds: number
  /** If true, the URL forces Content-Disposition: attachment. */
  download?: boolean
}

export interface HeadResult {
  size: number
  contentType: string
  etag?: string
}

export interface StorageAdapter {
  /** Upload bytes to `key`. Overwrites existing object. */
  upload(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: UploadOptions,
  ): Promise<void>

  /** Idempotent delete. Returns false if the object did not exist. */
  delete(key: string): Promise<boolean>

  /**
   * Returns a URL the client can GET directly.
   * - s3: presigned GetObject URL
   * - supabase: createSignedUrl
   * - local-fs: same-origin backend route URL (not actually signed; relies on session)
   */
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>

  /** Returns metadata, or null if the object does not exist. */
  head(key: string): Promise<HeadResult | null>
}

/** Bucket name used by every backend that needs one. Centralised so the
 *  factory + scripts share a single source of truth. */
export const BUCKET = 'event-photos'

/** Validate that a key matches the canonical shape and contains no
 *  backend prefix. Throws to fail loud rather than silently misroute. */
export function assertCanonicalKey(key: string): void {
  if (!key || key.startsWith('/') || key.startsWith(`${BUCKET}/`)) {
    throw new Error(`storage: key must be backend-agnostic (got "${key}")`)
  }
  if (key.includes('..') || key.includes('//')) {
    throw new Error(`storage: invalid key "${key}"`)
  }
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `cd backend && npm test -- adapter.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/storage/adapter.ts backend/src/_shared/storage/adapter.test.ts
git commit -m "feat(storage): add StorageAdapter interface and canonical-key guard"
```

---

### Task 3: Add the factory stub

A no-op factory that throws helpfully when called without the env wired. The real branches land in later tasks; this commit puts the seam in place and gives later code a name to import.

**Files:**
- Create: `backend/src/_shared/storage/factory.ts`
- Create: `backend/src/_shared/storage/factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/_shared/storage/factory.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { getStorage, _resetStorageForTests } from './factory.js'

afterEach(() => {
  _resetStorageForTests()
  delete process.env.PLANNEN_STORAGE_BACKEND
})

describe('getStorage', () => {
  it('throws when PLANNEN_STORAGE_BACKEND is unset', () => {
    expect(() => getStorage()).toThrow(/PLANNEN_STORAGE_BACKEND/)
  })

  it('throws on an unknown backend value', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'gcs'
    expect(() => getStorage()).toThrow(/unknown storage backend.*gcs/i)
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `cd backend && npm test -- factory.test`
Expected: FAIL with module not found

- [ ] **Step 3: Write the factory**

```ts
// backend/src/_shared/storage/factory.ts
//
// Boot-time singleton selector. Reads PLANNEN_STORAGE_BACKEND once and
// caches the result; tests can call _resetStorageForTests() between runs.
//
// The real adapter branches land in later tasks — this file ships with
// the surface only so the import path is stable.

import type { StorageAdapter } from './adapter.js'

let cached: StorageAdapter | null = null

export function getStorage(): StorageAdapter {
  if (cached) return cached
  const choice = process.env.PLANNEN_STORAGE_BACKEND
  if (!choice) {
    throw new Error(
      'storage: PLANNEN_STORAGE_BACKEND is not set. ' +
        'Expected one of: local-fs, supabase, s3.',
    )
  }
  switch (choice) {
    case 'local-fs':
    case 'supabase':
    case 's3':
      throw new Error(`storage: backend "${choice}" not yet wired (factory stub)`)
    default:
      throw new Error(`storage: unknown storage backend "${choice}"`)
  }
}

/** Test-only escape hatch — must NOT be called from production code paths. */
export function _resetStorageForTests(): void {
  cached = null
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `cd backend && npm test -- factory.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/storage/factory.ts backend/src/_shared/storage/factory.test.ts
git commit -m "feat(storage): add factory stub with backend selection guard"
```

---

## Phase 1 — `local-fs` Adapter (Tier 0 default)

### Task 4: Implement the local-fs adapter

Extract the file ops out of `routes/storage/eventPhotos.ts` into a free-standing adapter so both the legacy mirror route and the new `/api/photos/*` endpoints share one path-traversal guard, one MIME table, and one set of error shapes.

**Files:**
- Create: `backend/src/_shared/storage/localFs.ts`
- Create: `backend/src/_shared/storage/localFs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/_shared/storage/localFs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalFsAdapter } from './localFs.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plannen-localfs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('localFs adapter', () => {
  it('upload then head returns size + content-type', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    const bytes = new Uint8Array([1, 2, 3, 4])
    await adapter.upload('user-1/event-1/abc.jpg', bytes, { contentType: 'image/jpeg' })
    expect(existsSync(join(root, 'event-photos', 'user-1/event-1/abc.jpg'))).toBe(true)
    const head = await adapter.head('user-1/event-1/abc.jpg')
    expect(head).toEqual({ size: 4, contentType: 'image/jpeg' })
  })

  it('delete returns true for existing object, false for missing', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    await adapter.upload('user-1/event-1/a.bin', new Uint8Array([0]), { contentType: 'application/octet-stream' })
    expect(await adapter.delete('user-1/event-1/a.bin')).toBe(true)
    expect(await adapter.delete('user-1/event-1/a.bin')).toBe(false)
  })

  it('signedUrl returns an origin-relative path under the public mirror', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://127.0.0.1:54323' })
    const url = await adapter.signedUrl('user-1/event-1/a.jpg', { ttlSeconds: 3600 })
    expect(url).toBe('http://127.0.0.1:54323/storage/v1/object/public/event-photos/user-1/event-1/a.jpg')
  })

  it('rejects path traversal', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    await expect(adapter.upload('../etc/passwd', new Uint8Array([0]), { contentType: 'x' }))
      .rejects.toThrow(/key/i)
  })

  it('head returns null for missing object', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    expect(await adapter.head('nope/missing.jpg')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL: module not found)**

Run: `cd backend && npm test -- localFs.test`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/_shared/storage/localFs.ts
//
// File-system implementation of StorageAdapter. Replaces the inline logic
// previously in routes/storage/eventPhotos.ts; the route now delegates here.
//
// signedUrl() returns a same-origin URL pointing at the public mirror
// route — this is NOT a cryptographically signed URL. Tier 0 is
// single-user and the route lives behind the same auth middleware as
// every other backend call, so a signed wrapper would be theatre.

import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { resolve, join, dirname, extname, sep } from 'node:path'
import type { StorageAdapter, UploadOptions, SignedUrlOptions, HeadResult } from './adapter.js'
import { assertCanonicalKey, BUCKET } from './adapter.js'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
}

export interface LocalFsOptions {
  /** Absolute path to <photosRoot>; the adapter writes under <photosRoot>/event-photos/. */
  photosRoot: string
  /** Base URL the backend listens on (e.g. http://127.0.0.1:54323).
   *  Used to construct same-origin signed URLs. Pass '' for relative URLs. */
  originBaseUrl: string
}

export function createLocalFsAdapter(opts: LocalFsOptions): StorageAdapter {
  const root = resolve(opts.photosRoot)

  function safePath(key: string): string {
    assertCanonicalKey(key)
    const candidate = resolve(root, BUCKET, key)
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      throw new Error(`storage(localFs): path traversal blocked for key "${key}"`)
    }
    return candidate
  }

  return {
    async upload(key, body, _options: UploadOptions) {
      const target = safePath(key)
      await mkdir(dirname(target), { recursive: true })
      const bytes = body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body).arrayBuffer())
      await writeFile(target, bytes)
    },

    async delete(key) {
      const target = safePath(key)
      try {
        await unlink(target)
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    },

    async signedUrl(key, _opts: SignedUrlOptions) {
      assertCanonicalKey(key)
      const prefix = opts.originBaseUrl.replace(/\/+$/, '')
      return `${prefix}/storage/v1/object/public/${BUCKET}/${key}`
    },

    async head(key): Promise<HeadResult | null> {
      const target = safePath(key)
      try {
        const st = await stat(target)
        const ext = extname(target).toLowerCase()
        return {
          size: st.size,
          contentType: MIME[ext] ?? 'application/octet-stream',
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
  }
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `cd backend && npm test -- localFs.test`
Expected: PASS (all 5 assertions)

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/storage/localFs.ts backend/src/_shared/storage/localFs.test.ts
git commit -m "feat(storage): add local-fs adapter"
```

---

### Task 5: Refactor `routes/storage/eventPhotos.ts` to use the adapter

The legacy `/storage/v1/object/event-photos/*` mirror route stays (frontend Tier-0 code still calls it directly today), but its body delegates to the adapter so we have one implementation. The route module also exports a factory so the test can inject a temp `photosRoot` without env mutation.

**Files:**
- Modify: `backend/src/routes/storage/eventPhotos.ts`
- Modify: `backend/src/routes/storage/eventPhotos.test.ts` (keep existing tests passing)

- [ ] **Step 1: Rewrite the route to delegate**

Replace the whole file:

```ts
// backend/src/routes/storage/eventPhotos.ts
//
// Legacy Supabase Storage REST mirror, retained for backward compatibility
// with frontend code that still constructs /storage/v1/object/event-photos/*
// URLs directly (Tier 0 dbClient). New code should call the /api/photos/*
// endpoints instead, which work for any backend.
//
//   PUT  /storage/v1/object/event-photos/<key>          → adapter.upload
//   GET  /storage/v1/object/public/event-photos/<key>   → streams file from disk
//   DELETE /storage/v1/object/event-photos/<key>        → adapter.delete

import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import { HttpError } from '../../middleware/error.js'
import { createLocalFsAdapter } from '../../_shared/storage/localFs.js'
import { BUCKET } from '../../_shared/storage/adapter.js'
import type { AppVariables } from '../../types.js'

export const eventPhotos = new Hono<{ Variables: AppVariables }>()

const photosRoot = () =>
  resolve(process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'))

const originBaseUrl = () =>
  process.env.PLANNEN_BACKEND_ORIGIN ?? `http://127.0.0.1:${process.env.PLANNEN_BACKEND_PORT ?? 54323}`

function adapter() {
  return createLocalFsAdapter({ photosRoot: photosRoot(), originBaseUrl: originBaseUrl() })
}

function keyFromPath(pathname: string, prefix: string): string {
  const idx = pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const rest = decodeURIComponent(pathname.slice(idx + prefix.length))
  if (!rest) throw new HttpError(400, 'INVALID_PATH', 'Missing path')
  return rest
}

eventPhotos.put('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const key = keyFromPath(url.pathname, '/storage/v1/object/event-photos/')
  const contentType = c.req.header('content-type') ?? 'application/octet-stream'
  try {
    const body = new Uint8Array(await c.req.arrayBuffer())
    await adapter().upload(key, body, { contentType })
  } catch (e) {
    if (e instanceof Error && /path traversal|invalid key/i.test(e.message)) {
      throw new HttpError(400, 'INVALID_PATH', e.message)
    }
    throw e
  }
  return c.json({ data: { Key: `${BUCKET}/${key}` } })
})

eventPhotos.get('/public/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const key = keyFromPath(url.pathname, '/storage/v1/object/public/event-photos/')
  // Stream the file directly — adapter.signedUrl would just point back here,
  // so we read disk inline rather than HEAD-then-redirect.
  const target = resolve(photosRoot(), BUCKET, key)
  if (!target.startsWith(photosRoot() + sep)) {
    throw new HttpError(400, 'INVALID_PATH', 'Path traversal blocked')
  }
  try {
    await stat(target)
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'File not found')
  }
  const data = await readFile(target)
  const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
  }
  const ct = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  return new Response(data, { headers: { 'Content-Type': ct } })
})

eventPhotos.delete('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const key = keyFromPath(url.pathname, '/storage/v1/object/event-photos/')
  await adapter().delete(key)
  return c.json({ data: { Key: `${BUCKET}/${key}` } })
})
```

- [ ] **Step 2: Run existing route tests (expect PASS unchanged)**

Run: `cd backend && npm test -- eventPhotos.test`
Expected: all 4 tests PASS (PUT+GET roundtrip, DELETE removes, traversal rejected, 404 missing).

- [ ] **Step 3: Add a regression test for the adapter delegation**

Append to `backend/src/routes/storage/eventPhotos.test.ts`:

```ts
it('PUT routes through the localFs adapter (canonical key, no event-photos/ prefix in URL)', async () => {
    // Keys with a leading "event-photos/" prefix would double-prefix on disk —
    // the adapter rejects them. Verify the route surface still strips correctly.
    const put = await app.request(
      `/storage/v1/object/event-photos/${testUserId}/sub/dir/x.jpg`,
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([0]) },
    )
    expect(put.status).toBe(200)
    expect(existsSync(join(photosRoot, 'event-photos', testUserId, 'sub', 'dir', 'x.jpg'))).toBe(true)
  })
```

- [ ] **Step 4: Run tests (expect PASS)**

Run: `cd backend && npm test -- eventPhotos.test`
Expected: all 5 tests PASS.

- [ ] **Step 5: Wire the factory to return the local-fs adapter**

Edit `backend/src/_shared/storage/factory.ts` — replace the `case 'local-fs':` body:

```ts
import { createLocalFsAdapter } from './localFs.js'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

// ... inside getStorage()'s switch ...
    case 'local-fs': {
      const photosRoot = resolve(process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'))
      const originBaseUrl = process.env.PLANNEN_BACKEND_ORIGIN
        ?? `http://127.0.0.1:${process.env.PLANNEN_BACKEND_PORT ?? 54323}`
      cached = createLocalFsAdapter({ photosRoot, originBaseUrl })
      return cached
    }
```

- [ ] **Step 6: Add a factory test for the local-fs branch**

Add to `backend/src/_shared/storage/factory.test.ts`:

```ts
it('returns a local-fs adapter when PLANNEN_STORAGE_BACKEND=local-fs', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'plannen-factory-'))
    process.env.PLANNEN_STORAGE_BACKEND = 'local-fs'
    process.env.PLANNEN_PHOTOS_ROOT = root
    try {
      const a = getStorage()
      await a.upload('u/e/x.jpg', new Uint8Array([1]), { contentType: 'image/jpeg' })
      expect(await a.head('u/e/x.jpg')).toEqual({ size: 1, contentType: 'image/jpeg' })
    } finally {
      rmSync(root, { recursive: true, force: true })
      delete process.env.PLANNEN_PHOTOS_ROOT
    }
  })
```

- [ ] **Step 7: Run all storage tests (expect PASS)**

Run: `cd backend && npm test -- _shared/storage`
Expected: 3 files, all PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/storage/eventPhotos.ts backend/src/routes/storage/eventPhotos.test.ts backend/src/_shared/storage/factory.ts backend/src/_shared/storage/factory.test.ts
git commit -m "feat(storage): route eventPhotos through the local-fs adapter"
```

---

## Phase 2 — `supabase` Adapter (Tier 1/2 default)

### Task 6: Implement the Supabase Storage adapter

The backend has no `@supabase/supabase-js` dependency and we don't want to add one for four REST calls. The adapter speaks the Storage REST API directly via `fetch`. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment.

**Files:**
- Create: `backend/src/_shared/storage/supabase.ts`
- Create: `backend/src/_shared/storage/supabase.test.ts`

- [ ] **Step 1: Write the failing test (with a stub fetch)**

```ts
// backend/src/_shared/storage/supabase.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createSupabaseAdapter } from './supabase.js'

function makeFetch(responses: Array<Partial<Response> & { _body?: unknown }>) {
  const seen: Array<{ url: string; method: string; headers: Record<string,string>; body?: unknown }> = []
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const r = responses.shift()
    if (!r) throw new Error('unexpected extra fetch call')
    const url = typeof input === 'string' ? input : input.toString()
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers ?? {})),
      body: init?.body,
    })
    return new Response(JSON.stringify(r._body ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'application/json' },
    }) as Response
  })
  return Object.assign(fn, { calls: seen })
}

const baseOpts = {
  supabaseUrl: 'https://abc.supabase.co',
  serviceRoleKey: 'svc-key',
}

describe('supabase adapter', () => {
  it('upload POSTs binary bytes with x-upsert and service-role auth', async () => {
    const fetchFn = makeFetch([{ status: 200, _body: { Key: 'event-photos/u/e/x.jpg' } }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    await a.upload('u/e/x.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })
    expect(fetchFn.calls[0].url).toBe('https://abc.supabase.co/storage/v1/object/event-photos/u/e/x.jpg')
    expect(fetchFn.calls[0].method).toBe('POST')
    expect(fetchFn.calls[0].headers['authorization']).toBe('Bearer svc-key')
    expect(fetchFn.calls[0].headers['content-type']).toBe('image/jpeg')
    expect(fetchFn.calls[0].headers['x-upsert']).toBe('true')
  })

  it('signedUrl POSTs to /storage/v1/object/sign and returns absolute URL', async () => {
    const fetchFn = makeFetch([{
      status: 200,
      _body: { signedURL: '/storage/v1/object/sign/event-photos/u/e/x.jpg?token=t' },
    }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    const url = await a.signedUrl('u/e/x.jpg', { ttlSeconds: 900 })
    expect(fetchFn.calls[0].url).toBe('https://abc.supabase.co/storage/v1/object/sign/event-photos/u/e/x.jpg')
    expect(JSON.parse(String(fetchFn.calls[0].body))).toEqual({ expiresIn: 900 })
    expect(url).toBe('https://abc.supabase.co/storage/v1/object/sign/event-photos/u/e/x.jpg?token=t')
  })

  it('delete returns false when supabase reports the object missing', async () => {
    const fetchFn = makeFetch([{ status: 200, _body: { message: 'Not found' } }, { status: 404, _body: { message: 'Not found' } }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    // First delete: head returns 200 → exists → unlink → true.
    // We'll test the missing path directly here using the second response.
    // Simulate the missing-then-delete path:
    const fetch2 = makeFetch([{ status: 404 }])
    const b = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetch2 })
    expect(await b.delete('u/e/missing.jpg')).toBe(false)
  })

  it('head returns null on 404', async () => {
    const fetchFn = makeFetch([{ status: 404 }])
    const a = createSupabaseAdapter({ ...baseOpts, fetchImpl: fetchFn })
    expect(await a.head('u/e/missing.jpg')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL: module not found)**

Run: `cd backend && npm test -- supabase.test`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/_shared/storage/supabase.ts
//
// Supabase Storage adapter. Talks to Supabase's Storage REST API directly
// via fetch (no @supabase/supabase-js dep). Uses the service-role key so
// the backend can mint signed URLs without re-implementing RLS.
//
// Bucket auth model: the bucket's own RLS policies still apply for direct
// browser uploads via supabase-js (Tier 1/2 backward-compat path); when
// the backend mints a signed URL we bypass RLS by virtue of holding the
// service role, but only after the caller has verified ownership in
// plannen.event_memories.

import type { StorageAdapter, UploadOptions, SignedUrlOptions, HeadResult } from './adapter.js'
import { BUCKET, assertCanonicalKey } from './adapter.js'

export interface SupabaseAdapterOptions {
  supabaseUrl: string
  serviceRoleKey: string
  /** Override fetch (used by tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function createSupabaseAdapter(opts: SupabaseAdapterOptions): StorageAdapter {
  const base = opts.supabaseUrl.replace(/\/+$/, '')
  const f = opts.fetchImpl ?? fetch
  const auth = { authorization: `Bearer ${opts.serviceRoleKey}` }

  function objectUrl(key: string): string {
    return `${base}/storage/v1/object/${BUCKET}/${key}`
  }

  return {
    async upload(key, body, options: UploadOptions) {
      assertCanonicalKey(key)
      const bytes = body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body).arrayBuffer())
      const res = await f(objectUrl(key), {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': options.contentType,
          'cache-control': options.cacheControl ?? 'private, max-age=3600',
          'x-upsert': 'true',
        },
        body: bytes,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): upload failed ${res.status} ${detail}`)
      }
    },

    async delete(key) {
      assertCanonicalKey(key)
      const res = await f(objectUrl(key), { method: 'DELETE', headers: auth })
      if (res.status === 404) return false
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): delete failed ${res.status} ${detail}`)
      }
      return true
    },

    async signedUrl(key, urlOpts: SignedUrlOptions) {
      assertCanonicalKey(key)
      const res = await f(`${base}/storage/v1/object/sign/${BUCKET}/${key}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          expiresIn: urlOpts.ttlSeconds,
          ...(urlOpts.download ? { download: true } : {}),
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): sign failed ${res.status} ${detail}`)
      }
      const body = await res.json() as { signedURL?: string }
      if (!body.signedURL) throw new Error('storage(supabase): sign returned no signedURL')
      return `${base}${body.signedURL}`
    },

    async head(key): Promise<HeadResult | null> {
      assertCanonicalKey(key)
      // Supabase Storage doesn't expose a true HEAD; use the info endpoint.
      const res = await f(`${base}/storage/v1/object/info/${BUCKET}/${key}`, {
        method: 'GET',
        headers: auth,
      })
      if (res.status === 404) return null
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): info failed ${res.status} ${detail}`)
      }
      const body = await res.json() as { size?: number; contentType?: string; mimetype?: string; etag?: string }
      return {
        size: body.size ?? 0,
        contentType: body.contentType ?? body.mimetype ?? 'application/octet-stream',
        etag: body.etag,
      }
    },
  }
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `cd backend && npm test -- supabase.test`
Expected: PASS

- [ ] **Step 5: Wire the factory's `supabase` branch**

Edit `backend/src/_shared/storage/factory.ts`, replace the `case 'supabase':` body:

```ts
import { createSupabaseAdapter } from './supabase.js'

// ... inside getStorage()'s switch ...
    case 'supabase': {
      const supabaseUrl = process.env.SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
          'storage(supabase): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
        )
      }
      cached = createSupabaseAdapter({ supabaseUrl, serviceRoleKey })
      return cached
    }
```

- [ ] **Step 6: Add a factory test for the supabase branch**

Append to `backend/src/_shared/storage/factory.test.ts`:

```ts
it('returns a supabase adapter when PLANNEN_STORAGE_BACKEND=supabase', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'supabase'
    process.env.SUPABASE_URL = 'https://abc.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    try {
      expect(getStorage()).toBeDefined()
    } finally {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  })

  it('refuses supabase when credentials are missing', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'supabase'
    expect(() => getStorage()).toThrow(/SUPABASE_URL/)
  })
```

- [ ] **Step 7: Run tests (expect PASS)**

Run: `cd backend && npm test -- _shared/storage`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/_shared/storage/supabase.ts backend/src/_shared/storage/supabase.test.ts backend/src/_shared/storage/factory.ts backend/src/_shared/storage/factory.test.ts
git commit -m "feat(storage): add Supabase Storage REST adapter"
```

---

## Phase 3 — `s3` Adapter (R2 / Tigris / B2 / MinIO)

### Task 7: Add S3 SDK dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install the AWS SDK v3 client + presigner**

Run:
```bash
cd backend && npm install @aws-sdk/client-s3@^3.700.0 @aws-sdk/s3-request-presigner@^3.700.0
```

- [ ] **Step 2: Verify the lockfile and package.json**

Run: `cd backend && cat package.json | grep -E '@aws-sdk'`
Expected: two `@aws-sdk/...` entries under `dependencies`.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "feat(storage): add @aws-sdk/client-s3 deps for s3 adapter"
```

---

### Task 8: Implement the S3 adapter

**Files:**
- Create: `backend/src/_shared/storage/s3.ts`
- Create: `backend/src/_shared/storage/s3.test.ts`

- [ ] **Step 1: Write the failing test (using aws-sdk-client-mock)**

Run: `cd backend && npm install --save-dev aws-sdk-client-mock@^4.0.0`

```ts
// backend/src/_shared/storage/s3.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { createS3Adapter } from './s3.js'

const s3Mock = mockClient(S3Client)

beforeEach(() => {
  s3Mock.reset()
})

const baseOpts = {
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'plannen-photos',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  publicBaseUrl: 'https://photos.example.com',
  forcePathStyle: false,
}

describe('s3 adapter', () => {
  it('upload sends PutObjectCommand with bucket+key', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    const a = createS3Adapter(baseOpts)
    await a.upload('u/e/x.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input.Bucket).toBe('plannen-photos')
    expect(calls[0].args[0].input.Key).toBe('u/e/x.jpg')
    expect(calls[0].args[0].input.ContentType).toBe('image/jpeg')
  })

  it('delete returns true on success and false on NoSuchKey', async () => {
    s3Mock.on(DeleteObjectCommand).resolvesOnce({}).rejectsOnce({ name: 'NoSuchKey' })
    const a = createS3Adapter(baseOpts)
    expect(await a.delete('u/e/exists.jpg')).toBe(true)
    expect(await a.delete('u/e/missing.jpg')).toBe(false)
  })

  it('head returns metadata, or null on NotFound', async () => {
    s3Mock.on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 42, ContentType: 'image/png', ETag: '"abc"' })
      .rejectsOnce({ name: 'NotFound' })
    const a = createS3Adapter(baseOpts)
    expect(await a.head('u/e/a.png')).toEqual({ size: 42, contentType: 'image/png', etag: '"abc"' })
    expect(await a.head('u/e/missing.png')).toBeNull()
  })

  it('signedUrl returns a presigned URL string', async () => {
    const a = createS3Adapter(baseOpts)
    const url = await a.signedUrl('u/e/a.jpg', { ttlSeconds: 900 })
    // We can't deterministically assert the signature, but we can assert the
    // structural shape — host + key + X-Amz-* query params.
    expect(url).toContain('plannen-photos')
    expect(url).toContain('u/e/a.jpg')
    expect(url).toMatch(/X-Amz-Signature=/)
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL: module not found)**

Run: `cd backend && npm test -- s3.test`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/_shared/storage/s3.ts
//
// S3-compatible adapter. Defaults assume Cloudflare R2 (region "auto",
// virtual-hosted style URLs), but the same code works against Tigris, B2,
// DigitalOcean Spaces, Wasabi, and MinIO by changing the endpoint/region
// and toggling forcePathStyle.
//
// signedUrl() returns a presigned GetObject URL good for opts.ttlSeconds.
// Uploads use PutObject directly because the backend already has the
// service credentials; the /api/photos/upload-url endpoint mints a separate
// presigned PUT URL for direct browser→bucket uploads (Task 9).

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { StorageAdapter, UploadOptions, SignedUrlOptions, HeadResult } from './adapter.js'
import { assertCanonicalKey } from './adapter.js'

export interface S3AdapterOptions {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Public base URL for unsigned reads (custom domain or https://pub-<hash>.r2.dev).
   *  Not used by signedUrl (which always presigns). */
  publicBaseUrl: string
  /** true for MinIO, false for R2/Tigris/B2. */
  forcePathStyle: boolean
}

export function createS3Adapter(opts: S3AdapterOptions): StorageAdapter {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: opts.forcePathStyle,
  })
  const Bucket = opts.bucket

  return {
    async upload(key, body, options: UploadOptions) {
      assertCanonicalKey(key)
      const bytes = body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body).arrayBuffer())
      await client.send(new PutObjectCommand({
        Bucket,
        Key: key,
        Body: bytes,
        ContentType: options.contentType,
        CacheControl: options.cacheControl ?? 'private, max-age=3600',
      }))
    },

    async delete(key) {
      assertCanonicalKey(key)
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
        return true
      } catch (err) {
        const name = (err as { name?: string }).name ?? ''
        // R2/S3 may not return NoSuchKey on idempotent delete; treat
        // missing-key shapes as "not found" rather than failure.
        if (name === 'NoSuchKey' || name === 'NotFound') return false
        throw err
      }
    },

    async signedUrl(key, urlOpts: SignedUrlOptions) {
      assertCanonicalKey(key)
      const cmd = new GetObjectCommand({
        Bucket,
        Key: key,
        ...(urlOpts.download
          ? { ResponseContentDisposition: 'attachment' }
          : {}),
      })
      return await getSignedUrl(client, cmd, { expiresIn: urlOpts.ttlSeconds })
    },

    async head(key): Promise<HeadResult | null> {
      assertCanonicalKey(key)
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }))
        return {
          size: out.ContentLength ?? 0,
          contentType: out.ContentType ?? 'application/octet-stream',
          etag: out.ETag,
        }
      } catch (err) {
        const name = (err as { name?: string }).name ?? ''
        if (name === 'NotFound' || name === 'NoSuchKey') return null
        throw err
      }
    },
  }
}

/** Generate a presigned PUT URL the browser can upload directly to.
 *  Used by /api/photos/upload-url; not part of the StorageAdapter surface
 *  because only s3 needs it. */
export async function presignS3Upload(
  opts: S3AdapterOptions,
  key: string,
  contentType: string,
  ttlSeconds: number,
): Promise<string> {
  assertCanonicalKey(key)
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: opts.forcePathStyle,
  })
  const cmd = new PutObjectCommand({
    Bucket: opts.bucket,
    Key: key,
    ContentType: contentType,
  })
  return await getSignedUrl(client, cmd, { expiresIn: ttlSeconds })
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `cd backend && npm test -- s3.test`
Expected: 4 tests PASS.

- [ ] **Step 5: Wire the factory's `s3` branch**

Edit `backend/src/_shared/storage/factory.ts`:

```ts
import { createS3Adapter } from './s3.js'

// ... helper outside getStorage ...
function readS3Env() {
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'auto'
  const bucket = process.env.S3_BUCKET
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL ?? ''
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'
  const required = {
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  }
  const missingKeys = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
  if (missingKeys.length > 0) {
    throw new Error(`storage(s3): missing env: ${missingKeys.join(', ')}`)
  }
  return { endpoint: endpoint!, region, bucket: bucket!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, publicBaseUrl, forcePathStyle }
}

// ... inside getStorage()'s switch ...
    case 's3': {
      cached = createS3Adapter(readS3Env())
      return cached
    }
```

- [ ] **Step 6: Add a factory test for the s3 branch**

```ts
// Append to backend/src/_shared/storage/factory.test.ts

it('returns an s3 adapter when PLANNEN_STORAGE_BACKEND=s3 and all keys present', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 's3'
    process.env.S3_ENDPOINT = 'https://acc.r2.cloudflarestorage.com'
    process.env.S3_BUCKET = 'plannen-photos'
    process.env.S3_ACCESS_KEY_ID = 'AK'
    process.env.S3_SECRET_ACCESS_KEY = 'SK'
    try {
      expect(getStorage()).toBeDefined()
    } finally {
      delete process.env.S3_ENDPOINT
      delete process.env.S3_BUCKET
      delete process.env.S3_ACCESS_KEY_ID
      delete process.env.S3_SECRET_ACCESS_KEY
    }
  })

  it('refuses s3 when a required key is missing', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 's3'
    process.env.S3_ENDPOINT = 'https://acc.r2.cloudflarestorage.com'
    // intentionally omit S3_BUCKET
    process.env.S3_ACCESS_KEY_ID = 'AK'
    process.env.S3_SECRET_ACCESS_KEY = 'SK'
    try {
      expect(() => getStorage()).toThrow(/S3_BUCKET/)
    } finally {
      delete process.env.S3_ENDPOINT
      delete process.env.S3_ACCESS_KEY_ID
      delete process.env.S3_SECRET_ACCESS_KEY
    }
  })
```

- [ ] **Step 7: Run all storage tests (expect PASS)**

Run: `cd backend && npm test -- _shared/storage`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/_shared/storage/s3.ts backend/src/_shared/storage/s3.test.ts backend/src/_shared/storage/factory.ts backend/src/_shared/storage/factory.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(storage): add S3-compatible adapter (R2/Tigris/B2/MinIO)"
```

---

## Phase 4 — Backend `/api/photos/*` endpoints

### Task 9: Add the photos route module

Three endpoints, all under `/api/photos`:
- `POST /upload-url` — body `{ event_id, filename, content_type }` → returns `{ key, upload_url, method, headers? }`. The backend picks the canonical key, verifies the caller can attach to `event_id`, then either presigns S3 or returns a same-origin URL for `local-fs` / `supabase`.
- `GET /signed-url?key=…` — verifies the caller owns the underlying `event_memories` row (or it's not yet attached, i.e. caller currently uploading), then returns `{ url }`.
- `DELETE /` — body `{ key }` → verifies ownership, calls `adapter.delete`.

**Files:**
- Create: `backend/src/routes/api/photos.ts`
- Create: `backend/src/routes/api/photos.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the failing test (covers all three endpoints across all three backends via env switches)**

```ts
// backend/src/routes/api/photos.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { _resetStorageForTests } from '../../_shared/storage/factory.js'

const testEmail = 'photos-api-test@plannen.local'
let testUserId: string
let photosRoot: string
let app: ReturnType<typeof buildApp>

beforeAll(async () => {
  photosRoot = mkdtempSync(join(tmpdir(), 'plannen-photos-api-'))
  process.env.PLANNEN_PHOTOS_ROOT = photosRoot
  process.env.PLANNEN_STORAGE_BACKEND = 'local-fs'
  const c = await pool.connect()
  try {
    const inserted = await c.query(
      `INSERT INTO auth.users (id, email)
       VALUES (gen_random_uuid(), $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [testEmail],
    )
    testUserId = inserted.rows[0].id
  } finally {
    c.release()
  }
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

beforeEach(() => {
  _resetStorageForTests()
})

afterAll(async () => {
  rmSync(photosRoot, { recursive: true, force: true })
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.users WHERE email = $1', [testEmail])
    await c.query('DELETE FROM auth.users WHERE email = $1', [testEmail])
  } finally {
    c.release()
  }
  delete process.env.PLANNEN_STORAGE_BACKEND
})

async function makeEvent(): Promise<string> {
  const c = await pool.connect()
  try {
    const r = await c.query(
      `INSERT INTO plannen.events (title, created_by, starts_at)
       VALUES ('photos-api test', $1, now()) RETURNING id`,
      [testUserId],
    )
    return r.rows[0].id
  } finally {
    c.release()
  }
}

describe('/api/photos', () => {
  it('POST /upload-url returns a key + URL for the local-fs backend', async () => {
    const eventId = await makeEvent()
    const res = await app.request('/api/photos/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, filename: 'IMG_1234.jpg', content_type: 'image/jpeg' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { key: string; upload_url: string; method: string }
    expect(body.key.startsWith(`${testUserId}/${eventId}/`)).toBe(true)
    expect(body.key.endsWith('.jpg')).toBe(true)
    expect(body.method).toBe('PUT')
    expect(body.upload_url).toContain(`/storage/v1/object/event-photos/${body.key}`)
  })

  it('POST /upload-url 403s when event belongs to another user', async () => {
    const c = await pool.connect()
    let otherUid = ''
    try {
      const r = await c.query(
        `INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'other@x') RETURNING id`,
      )
      otherUid = r.rows[0].id
      const e = await c.query(
        `INSERT INTO plannen.events (title, created_by, starts_at) VALUES ('x', $1, now()) RETURNING id`,
        [otherUid],
      )
      const res = await app.request('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: e.rows[0].id, filename: 'a.jpg', content_type: 'image/jpeg' }),
      })
      expect(res.status).toBe(403)
    } finally {
      await c.query(`DELETE FROM auth.users WHERE id = $1`, [otherUid])
      c.release()
    }
  })

  it('GET /signed-url returns a URL for a key owned by the caller', async () => {
    const eventId = await makeEvent()
    const c = await pool.connect()
    let key: string
    try {
      key = `${testUserId}/${eventId}/abc.jpg`
      await c.query(
        `INSERT INTO plannen.event_memories (event_id, user_id, storage_key, media_type)
         VALUES ($1, $2, $3, 'image')`,
        [eventId, testUserId, key],
      )
    } finally {
      c.release()
    }
    const res = await app.request(`/api/photos/signed-url?key=${encodeURIComponent(key)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toContain('/storage/v1/object/public/event-photos/')
  })

  it('DELETE removes the object and returns 204', async () => {
    const eventId = await makeEvent()
    const c = await pool.connect()
    let key: string
    try {
      // upload via the mirror route so the bytes exist on disk
      key = `${testUserId}/${eventId}/del.jpg`
      const put = await app.request(`/storage/v1/object/event-photos/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: new Uint8Array([0xff]),
      })
      expect(put.status).toBe(200)
      await c.query(
        `INSERT INTO plannen.event_memories (event_id, user_id, storage_key, media_type)
         VALUES ($1, $2, $3, 'image')`,
        [eventId, testUserId, key],
      )
    } finally {
      c.release()
    }
    const del = await app.request('/api/photos', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    expect(del.status).toBe(204)
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL: route module missing)**

Run: `cd backend && npm test -- photos.test`
Expected: FAIL

- [ ] **Step 3: Write the route module**

```ts
// backend/src/routes/api/photos.ts
//
// Backend-agnostic photo endpoints. Frontend code calls these via
// src/lib/storageClient.ts and never touches the underlying storage
// service directly. Every endpoint verifies ownership in the DB before
// minting a URL or touching bytes.

import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import { getStorage } from '../../_shared/storage/factory.js'
import { presignS3Upload } from '../../_shared/storage/s3.js'
import { BUCKET, assertCanonicalKey } from '../../_shared/storage/adapter.js'
import type { AppVariables } from '../../types.js'

export const photos = new Hono<{ Variables: AppVariables }>()

const UploadUrlBody = z.object({
  event_id: z.string().uuid(),
  filename: z.string().min(1).max(200),
  content_type: z.string().min(1).max(120),
})

const SIGNED_TTL_SECONDS = 900   // 15 minutes — matches spec
const UPLOAD_TTL_SECONDS = 900

function extOf(filename: string, contentType: string): string {
  const m = filename.match(/\.([a-z0-9]{1,8})$/i)
  if (m) return m[1].toLowerCase()
  // Fall back to a content-type → ext map for picker downloads with no filename.
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic',
    'video/mp4': 'mp4', 'video/quicktime': 'mov',
    'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  }
  return map[contentType] ?? 'bin'
}

async function assertEventOwned(userId: string, eventId: string): Promise<void> {
  await withUserContext(userId, async (db) => {
    const r = await db.query(
      `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [eventId, userId],
    )
    if (r.rowCount === 0) throw new HttpError(403, 'FORBIDDEN', 'event not owned by caller')
  })
}

async function assertKeyOwned(userId: string, key: string): Promise<void> {
  await withUserContext(userId, async (db) => {
    // The key prefix is <userId>/... — both check that the caller wrote it
    // AND that an event_memories row exists pointing at it.
    if (!key.startsWith(`${userId}/`)) {
      throw new HttpError(403, 'FORBIDDEN', 'key prefix mismatch')
    }
    const r = await db.query(
      `SELECT 1 FROM plannen.event_memories WHERE storage_key = $1 AND user_id = $2 LIMIT 1`,
      [key, userId],
    )
    if (r.rowCount === 0) throw new HttpError(403, 'FORBIDDEN', 'key not registered to caller')
  })
}

photos.post('/upload-url', async (c) => {
  const userId = c.var.userId
  const parsed = UploadUrlBody.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid body', JSON.stringify(parsed.error.issues))
  const { event_id, filename, content_type } = parsed.data
  await assertEventOwned(userId, event_id)

  const ext = extOf(filename, content_type)
  const key = `${userId}/${event_id}/${randomUUID()}.${ext}`
  assertCanonicalKey(key)

  const backend = process.env.PLANNEN_STORAGE_BACKEND
  if (backend === 's3') {
    // Presign a PUT URL the browser uploads to directly.
    const opts = {
      endpoint: process.env.S3_ENDPOINT!,
      region: process.env.S3_REGION ?? 'auto',
      bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    }
    const upload_url = await presignS3Upload(opts, key, content_type, UPLOAD_TTL_SECONDS)
    return c.json({
      key,
      upload_url,
      method: 'PUT',
      headers: { 'content-type': content_type },
    })
  }

  if (backend === 'supabase') {
    // Mint a Supabase signed-upload URL so the browser can PUT directly to
    // Storage without holding any service credential. The signed-upload
    // endpoint is /storage/v1/object/upload/sign/<bucket>/<key>.
    const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const signRes = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${key}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    if (!signRes.ok) {
      const detail = await signRes.text().catch(() => '')
      throw new HttpError(502, 'STORAGE', `supabase sign failed: ${signRes.status} ${detail}`)
    }
    // The response has shape { url: '/storage/v1/...?token=...' } OR
    // { signedURL: '...' } depending on Supabase version. Accept either.
    const body = await signRes.json() as { url?: string; signedURL?: string; token?: string }
    const path = body.url ?? body.signedURL
    if (!path) throw new HttpError(502, 'STORAGE', 'supabase sign returned no url')
    return c.json({
      key,
      upload_url: path.startsWith('http') ? path : `${supabaseUrl}${path}`,
      method: 'PUT',
      headers: { 'content-type': content_type, 'x-upsert': 'true' },
    })
  }

  // local-fs: client PUTs to the Hono mirror route (same origin).
  return c.json({
    key,
    upload_url: `/storage/v1/object/${BUCKET}/${key}`,
    method: 'PUT',
    headers: { 'content-type': content_type },
  })
})

photos.get('/signed-url', async (c) => {
  const userId = c.var.userId
  const key = c.req.query('key')
  if (!key) throw new HttpError(400, 'VALIDATION', 'key is required')
  await assertKeyOwned(userId, key)
  const url = await getStorage().signedUrl(key, { ttlSeconds: SIGNED_TTL_SECONDS })
  return c.json({ url })
})

photos.delete('/', async (c) => {
  const userId = c.var.userId
  const body = await c.req.json().catch(() => ({})) as { key?: string }
  if (!body.key) throw new HttpError(400, 'VALIDATION', 'key is required')
  await assertKeyOwned(userId, body.key)
  await getStorage().delete(body.key)
  return c.body(null, 204)
})
```

- [ ] **Step 4: Mount the route in `backend/src/index.ts`**

Add the import + mount alongside the existing `/api/*` routes:

```ts
import { photos } from './routes/api/photos.js'
// ...
app.route('/api/photos', photos)
```

- [ ] **Step 5: Run the photos test (expect PASS)**

Run: `cd backend && npm test -- photos.test`
Expected: 4 tests PASS.

- [ ] **Step 6: Run the whole backend test suite as a smoke check**

Run: `cd backend && npm test`
Expected: previous suites still PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/api/photos.ts backend/src/routes/api/photos.test.ts backend/src/index.ts
git commit -m "feat(storage): add /api/photos endpoints backed by the storage factory"
```

---

## Phase 5 — Refactor server-side storage callers

### Task 10: Route the Node picker handler through the adapter

The Tier 1 picker poll handler currently PUTs every Google-Photos download to a hard-coded Supabase Storage URL. Replace with `getStorage().upload(...)` so the same code paths a downloaded picture into local-fs / supabase / s3 depending on profile.

**Files:**
- Modify: `backend/src/_shared/handlers/picker-session-poll.ts`

- [ ] **Step 1: Replace the upload block**

Locate the block in `picker-session-poll.ts` around line 210 and replace:

```ts
    // BEFORE: hard-coded Supabase Storage REST PUT
    // const storagePut = await fetch(
    //   `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/event-photos/${path}`,
    //   { method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' }, body: blob },
    // )
    // if (!storagePut.ok) { … skip … }
    // const publicUrl = `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/public/event-photos/${path}`

    // AFTER: adapter-routed upload + signedUrl
    const storageKey = `${ctx.userId}/${eventId}/${item.id}.${ext}`
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await getStorage().upload(storageKey, bytes, {
        contentType: contentType || 'application/octet-stream',
      })
    } catch (e) {
      skipped.push({ external_id: item.id, reason: `upload failed: ${(e as Error).message}` })
      continue
    }
    // Long-lived URL: signed for 1 hour. The frontend re-fetches via
    // /api/photos/signed-url for older memories — this initial URL is just
    // for the immediate UI response.
    const publicUrl = await getStorage().signedUrl(storageKey, { ttlSeconds: 3600 })
```

Then update the `INSERT INTO plannen.event_memories` to also write `storage_key`:

```ts
    const insertResult = await ctx.db.query(
      `INSERT INTO plannen.event_memories
         (event_id, user_id, source, external_id, media_url, storage_key, media_type, taken_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        eventId, ctx.userId, 'google_photos', item.id,
        publicUrl, storageKey,
        pickMediaType(contentType, item.mediaFile?.filename),
        item.createTime ?? null,
      ],
    )
```

Add the import:

```ts
import { getStorage } from '../storage/factory.js'
```

- [ ] **Step 2: Update existing picker tests**

Open `backend/src/_shared/handlers/picker-session-poll.test.ts`. At the top of `beforeAll` (or its equivalent setup hook):

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetStorageForTests } from '../storage/factory.js'

const photosRoot = mkdtempSync(join(tmpdir(), 'plannen-picker-'))
process.env.PLANNEN_PHOTOS_ROOT = photosRoot
process.env.PLANNEN_STORAGE_BACKEND = 'local-fs'
_resetStorageForTests()
```

Add a matching `afterAll`: `rmSync(photosRoot, { recursive: true, force: true })`.

Remove any `fetch` stubs that previously intercepted Supabase Storage PUTs — the adapter now writes directly to disk, so those stubs become dead code. Assertions on `STORAGE_PUBLIC_URL_BASE`-shaped URLs should be replaced with assertions that the file exists under `photosRoot/event-photos/<key>`.

- [ ] **Step 3: Run picker tests (expect PASS)**

Run: `cd backend && npm test -- picker-session-poll`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/_shared/handlers/picker-session-poll.ts backend/src/_shared/handlers/picker-session-poll.test.ts
git commit -m "feat(storage): route Node picker handler through the storage adapter"
```

---

### Task 11: Mirror the change in the Deno picker handler

The Supabase Edge function copy at `supabase/functions/_shared/handlers/picker-session-poll.ts` runs on Deno and must keep working for Tier 1 deployments that still use edge functions. Deno can import the same TypeScript adapter modules if we use Deno-compatible imports — but the cleanest path is to keep the edge-function variant on the Supabase REST path until Phase 2 of the tier-1-Node migration moves it to Node entirely.

**Files:**
- Modify: `supabase/functions/_shared/handlers/picker-session-poll.ts`

- [ ] **Step 1: Read PLANNEN_STORAGE_BACKEND and refuse non-supabase modes**

Add at the top of the handler:

```ts
const STORAGE_BACKEND = Deno.env.get('PLANNEN_STORAGE_BACKEND') ?? 'supabase'
if (STORAGE_BACKEND !== 'supabase') {
  throw new Error(
    `supabase edge picker-session-poll only supports PLANNEN_STORAGE_BACKEND=supabase ` +
    `(got "${STORAGE_BACKEND}"); set the Node backend as the picker poll target instead.`,
  )
}
```

Rationale: Tier 2 + s3 needs an `/api/photos/upload-url` surface served by the Node backend (or a Vercel function). Refusing here surfaces the misconfiguration loudly rather than silently dual-writing to Supabase Storage.

- [ ] **Step 2: Also persist storage_key alongside media_url**

Locate the existing `const path = \`${eventId}/${ctx.userId}/${item.id}.${ext}\`` line and the subsequent `INSERT INTO plannen.event_memories` block. The `path` value IS the canonical key — rename it to `storageKey` for clarity (or keep `path` and pass it as `storage_key`), and extend the insert:

```ts
    const storageKey = `${eventId}/${ctx.userId}/${item.id}.${ext}`
    // ... existing PUT to Supabase Storage at
    //   `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/event-photos/${storageKey}`
    // stays unchanged, since this handler runs only when backend === 'supabase'.
    const publicUrl = `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/public/event-photos/${storageKey}`
    const insertResult = await ctx.db.query(
      `INSERT INTO plannen.event_memories
         (event_id, user_id, source, external_id, media_url, storage_key, media_type, taken_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        eventId, ctx.userId, 'google_photos', item.id,
        publicUrl, storageKey,
        pickMediaType(contentType, item.mediaFile?.filename),
        item.createTime ?? null,
      ],
    )
```

- [ ] **Step 3: Smoke-test by deploying the function to a Tier-1 profile**

(Manual.) Run: `npx plannen functions deploy picker-session-poll --profile <local_sb-profile>` and exercise a picker flow end-to-end; confirm `event_memories.storage_key` is populated.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/handlers/picker-session-poll.ts
git commit -m "feat(storage): edge picker writes storage_key and refuses non-supabase backends"
```

---

## Phase 6 — Frontend `storageClient`

### Task 12: Add `src/lib/storageClient.ts`

A single client used by all UI code. Hides backend choice behind three methods (`upload`, `downloadUrl`, `delete`). Reads the runtime tier from `import.meta.env` so the client knows which transport to use.

**Files:**
- Create: `src/lib/storageClient.ts`
- Create: `src/lib/storageClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/storageClient.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('storageClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('upload calls /api/photos/upload-url then PUTs to the returned URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: 'u/e/x.jpg',
        upload_url: '/storage/v1/object/event-photos/u/e/x.jpg',
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    const out = await storageClient.upload({ eventId: '11111111-1111-1111-1111-111111111111', filename: 'IMG.jpg', blob })
    expect(out.key).toBe('u/e/x.jpg')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/photos/upload-url')
    expect(fetchMock.mock.calls[1][0]).toBe('/storage/v1/object/event-photos/u/e/x.jpg')
  })

  it('downloadUrl GETs /api/photos/signed-url and returns the url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://x/signed' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    const url = await storageClient.downloadUrl('u/e/x.jpg')
    expect(url).toBe('https://x/signed')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/photos/signed-url?key=u%2Fe%2Fx.jpg')
  })

  it('delete sends DELETE /api/photos with the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    await storageClient.delete('u/e/x.jpg')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/photos')
    expect((init as RequestInit).method).toBe('DELETE')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ key: 'u/e/x.jpg' })
  })
})
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `npm test -- storageClient.test`
Expected: FAIL

- [ ] **Step 3: Write the client**

```ts
// src/lib/storageClient.ts
//
// Frontend façade over /api/photos/*. UI components never construct
// storage URLs directly — they call upload() / downloadUrl() / delete()
// and the backend translates per the configured PLANNEN_STORAGE_BACKEND.

export interface UploadArgs {
  eventId: string
  filename: string
  blob: Blob
}

export interface UploadResult {
  key: string
  /** Initial signed URL, suitable for immediate display while the row is fresh. */
  signedUrl: string
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`storageClient.${label}: ${res.status} ${detail}`)
  }
  return await res.json() as T
}

export const storageClient = {
  async upload({ eventId, filename, blob }: UploadArgs): Promise<UploadResult> {
    const intent = await jsonOrThrow<{
      key: string
      upload_url: string
      method: string
      headers?: Record<string, string>
    }>(
      await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, filename, content_type: blob.type || 'application/octet-stream' }),
      }),
      'upload-url',
    )
    const putRes = await fetch(intent.upload_url, {
      method: intent.method,
      headers: intent.headers ?? { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => '')
      throw new Error(`storageClient.upload: PUT failed ${putRes.status} ${detail}`)
    }
    // Fetch a short-lived signed URL so the caller can render immediately.
    const signedUrl = await this.downloadUrl(intent.key)
    return { key: intent.key, signedUrl }
  },

  async downloadUrl(key: string): Promise<string> {
    const body = await jsonOrThrow<{ url: string }>(
      await fetch(`/api/photos/signed-url?key=${encodeURIComponent(key)}`),
      'signed-url',
    )
    return body.url
  },

  async delete(key: string): Promise<void> {
    const res = await fetch('/api/photos', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    if (!res.ok && res.status !== 204) {
      const detail = await res.text().catch(() => '')
      throw new Error(`storageClient.delete: ${res.status} ${detail}`)
    }
  },
}
```

- [ ] **Step 4: Run the test (expect PASS)**

Run: `npm test -- storageClient.test`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storageClient.ts src/lib/storageClient.test.ts
git commit -m "feat(storage): add frontend storageClient over /api/photos"
```

---

### Task 13: Rewire `dbClient.memories.uploadFile` to use `storageClient`

Both Tier 0 and Tier 1 implementations of `dbClient.memories.uploadFile` currently know about storage transport. Replace with a single thin call into `storageClient`. The shape of the return value (`{ key, publicUrl }`) is preserved so call sites (`eventCoverService`, picker UI) need no changes.

**Files:**
- Modify: `src/lib/dbClient/tier0.ts`
- Modify: `src/lib/dbClient/tier1.ts`

- [ ] **Step 1: Edit tier0.ts**

Replace the `uploadFile` method (around line 90):

```ts
    uploadFile: async ({ userId, filename, blob, contentType: _ct }) => {
      // The eventId is encoded into the legacy filename ("covers/<ts>.jpg")
      // for non-event uploads like event covers. We approximate by passing a
      // placeholder eventId of the caller's id so the canonical key is
      // <userId>/<userId>/<uuid>.<ext>. For real memory uploads the caller
      // already constructs an eventId — those paths should migrate to the
      // new (eventId, filename) shape over time.
      // TODO(adapter-v2): replace uploadFile shim with explicit { eventId, blob }
      const eventId = userId   // placeholder; covers don't have an event
      const { key, signedUrl } = await storageClient.upload({ eventId, filename, blob })
      return { key, publicUrl: signedUrl }
    },
```

Add the import: `import { storageClient } from '../storageClient.js'`

- [ ] **Step 2: Edit tier1.ts the same way**

Replace the `uploadFile` block (around line 133) with the same body as tier0.ts. The Tier 1 client no longer touches `supabase.storage` directly.

- [ ] **Step 3: Run UI test suite**

Run: `npm test -- dbClient`
Expected: tests PASS (or, if no existing tests, run `npm run lint && npm run typecheck` to confirm).

- [ ] **Step 4: Manual smoke (Tier 0)**

```bash
npx plannen up --profile <tier-0-profile>
# open http://localhost:4321 and upload a photo to any event
```
Verify the new memory shows up and the disk file exists at `~/.plannen/photos/event-photos/<userId>/<userId>/<uuid>.jpg`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dbClient/tier0.ts src/lib/dbClient/tier1.ts
git commit -m "feat(storage): route dbClient.memories.uploadFile through storageClient"
```

---

## Phase 7 — Profile + CLI integration

### Task 14: Add `PLANNEN_STORAGE_BACKEND` to profile defaults

When `profile create` runs, it should write a backend-appropriate default for the new env key. Tier 0 → `local-fs`, Tier 1/2 → `supabase`. The `--storage s3` flag forces s3; combining `--mode=local_pg --storage s3` is refused.

**Files:**
- Modify: `cli/commands/profile/create.mjs`
- Modify: `cli/lib/profiles.mjs` (the `defaultsForMode` / `portsFor` helpers)
- Modify: `cli/commands/profile/create.test.mjs` (if it exists) or create

- [ ] **Step 1: Add a helper `storageDefaultsForMode` in profiles.mjs**

```js
// cli/lib/profiles.mjs — add near portsFor()

export function storageBackendDefaultsForMode(mode, storageChoice) {
  // storageChoice may be 'local-fs' | 'supabase' | 's3' | undefined.
  if (storageChoice === 's3' && mode === 'local_pg') {
    throw new Error(
      "profile create: --storage=s3 is not allowed with --mode=local_pg.\n" +
      "Tier 0 is single-user local mode and keeps photos under ~/.plannen/photos.\n" +
      "Use --mode=local_sb or --mode=cloud_sb for an S3-backed deployment.",
    );
  }
  if (mode === 'local_pg') return { PLANNEN_STORAGE_BACKEND: 'local-fs' };
  // local_sb + cloud_sb default to supabase unless explicitly s3.
  if (storageChoice === 's3') return { PLANNEN_STORAGE_BACKEND: 's3' };
  return { PLANNEN_STORAGE_BACKEND: 'supabase' };
}
```

- [ ] **Step 2: Wire it into `invokeProfileCreate`**

Edit `cli/commands/profile/create.mjs`:

```js
import {
  // ...existing imports...
  storageBackendDefaultsForMode,
} from '../../lib/profiles.mjs';

// Add `storage` to args:
export const profileCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Create a new profile' },
  args: {
    name: { type: 'positional', description: 'Profile name', required: true },
    mode: { type: 'string', description: 'Deployment mode: local_pg | local_sb | cloud_sb', required: true },
    storage: { type: 'string', description: 'Storage backend: local-fs | supabase | s3 (default depends on mode)' },
    force: { type: 'boolean', description: 'Overwrite if a profile with this name exists' },
  },
  async run({ args }) { /* ...as before... */ },
});

// Inside invokeProfileCreate, after building manifest:
const storageDefaults = storageBackendDefaultsForMode(mode, rawArgs.storage);

writeEnvFile(getProfileEnvPath(name, env), {
  PLANNEN_TIER: modeToTier(mode),
  ...portsFor(mode, portOffset),
  ...storageDefaults,
});
```

- [ ] **Step 3: Add tests**

Create `cli/commands/profile/create.test.mjs` if missing, otherwise extend:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeProfileCreate } from './create.mjs';

let home;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plannen-cli-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('profile create --storage', () => {
  it('defaults to local-fs for local_pg', async () => {
    const { envPath } = await invokeProfileCreate({ name: 't', mode: 'local_pg' }, { env: { HOME: home } });
    expect(readFileSync(envPath, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=local-fs');
  });

  it('defaults to supabase for local_sb / cloud_sb', async () => {
    const { envPath: a } = await invokeProfileCreate({ name: 's1', mode: 'local_sb' }, { env: { HOME: home } });
    expect(readFileSync(a, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=supabase');
    const { envPath: b } = await invokeProfileCreate({ name: 'c1', mode: 'cloud_sb' }, { env: { HOME: home } });
    expect(readFileSync(b, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=supabase');
  });

  it('honours --storage s3 on cloud_sb', async () => {
    const { envPath } = await invokeProfileCreate(
      { name: 'r2', mode: 'cloud_sb', storage: 's3' },
      { env: { HOME: home } },
    );
    expect(readFileSync(envPath, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=s3');
  });

  it('refuses --storage s3 on local_pg', async () => {
    await expect(
      invokeProfileCreate({ name: 'bad', mode: 'local_pg', storage: 's3' }, { env: { HOME: home } }),
    ).rejects.toThrow(/not allowed with --mode=local_pg/);
  });
});
```

- [ ] **Step 4: Run CLI tests (expect PASS)**

Run: `npm test -- cli/commands/profile`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/profile/create.mjs cli/commands/profile/create.test.mjs cli/lib/profiles.mjs
git commit -m "feat(cli): profile create --storage with tier-0 s3 guard"
```

---

### Task 15: Add a "storage backend" step to `plannen cloud provision`

`cloud provision` walks the user through a fresh Tier 2 setup. Insert a step between `link-vercel` and `push-env-vercel` that asks which storage backend to use, and if `s3`, prompts for the four required S3_* keys, writes them to the profile env, and validates them by issuing a HEAD against the bucket.

**Files:**
- Modify: `cli/commands/cloud/provision.mjs`

- [ ] **Step 1: Add the new step to the step list**

Insert `'configure-storage'` between `'link-vercel'` and `'push-env-vercel'` in the steps array:

```js
const STEPS = [
  'preflight',
  'prompt-supabase',
  'link-supabase',
  'push-schema',
  'deploy-functions',
  'prompt-vercel',
  'link-vercel',
  'configure-storage',   // ← NEW
  'push-env-vercel',
  'first-deploy',
  'wire-auth',
  'enable-passkeys',
];
```

- [ ] **Step 2: Implement the step**

```js
case 'configure-storage': {
  log(`13/${STEPS.length}  configure storage backend`);
  const profileEnvPath = getProfileEnvPath(profileName);
  const current = readEnvFile(profileEnvPath);
  if (current.PLANNEN_STORAGE_BACKEND && current.PLANNEN_STORAGE_BACKEND !== 'supabase') {
    log(`     PLANNEN_STORAGE_BACKEND=${current.PLANNEN_STORAGE_BACKEND} already set — skipping prompt`);
    break;
  }
  const choice = await prompts({
    type: 'select',
    name: 'backend',
    message: 'Photo storage backend',
    choices: [
      { title: 'Supabase Storage (default, $0.09/GB egress)', value: 'supabase' },
      { title: 'S3-compatible (R2/Tigris/B2/MinIO — zero egress on R2)', value: 's3' },
    ],
    initial: 0,
  });
  if (choice.backend === 'supabase') {
    appendEnvFile(profileEnvPath, { PLANNEN_STORAGE_BACKEND: 'supabase' });
    break;
  }
  // s3 — collect the four required keys + the two optional ones.
  const s3 = await prompts([
    { type: 'text', name: 'S3_ENDPOINT', message: 'S3 endpoint URL (e.g. https://<acc>.r2.cloudflarestorage.com)' },
    { type: 'text', name: 'S3_REGION', message: 'S3 region (auto for R2)', initial: 'auto' },
    { type: 'text', name: 'S3_BUCKET', message: 'Bucket name', initial: 'plannen-photos' },
    { type: 'text', name: 'S3_ACCESS_KEY_ID', message: 'Access key id' },
    { type: 'password', name: 'S3_SECRET_ACCESS_KEY', message: 'Secret access key' },
    { type: 'text', name: 'S3_PUBLIC_BASE_URL', message: 'Public base URL (custom domain or https://pub-<hash>.r2.dev)' },
    { type: 'select', name: 'S3_FORCE_PATH_STYLE', message: 'Force path-style URLs?', choices: [
      { title: 'false (R2 / Tigris / B2)', value: 'false' },
      { title: 'true (MinIO)', value: 'true' },
    ], initial: 0 },
  ]);
  appendEnvFile(profileEnvPath, { PLANNEN_STORAGE_BACKEND: 's3', ...s3 });
  // Smoke-check the credentials: HEAD the bucket via a tiny aws-sdk call.
  await import('../../lib/storage-smoke.mjs').then((m) => m.smokeS3({ ...s3 }));
  log('     ✓ S3 credentials verified');
  break;
}
```

Create `cli/lib/storage-smoke.mjs` (a tiny helper that issues a `ListObjectsV2` with `MaxKeys=1`):

```js
// cli/lib/storage-smoke.mjs
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export async function smokeS3({ S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE }) {
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? 'auto',
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  });
  await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, MaxKeys: 1 }));
}
```

Add `@aws-sdk/client-s3` to the root `package.json` (it's needed for the CLI too, not just the backend):

Run: `npm install @aws-sdk/client-s3@^3.700.0`

- [ ] **Step 3: Manual smoke-run on a fresh profile**

```bash
npx plannen profile create r2-prod --mode=cloud_sb
npx plannen cloud provision --profile r2-prod
# choose "S3-compatible" when prompted; supply R2 keys
cat ~/.plannen/profiles/r2-prod/env | grep -E 'PLANNEN_STORAGE_BACKEND|^S3_'
```
Expected: env file contains `PLANNEN_STORAGE_BACKEND=s3` plus the six S3_* keys.

- [ ] **Step 4: Commit**

```bash
git add cli/commands/cloud/provision.mjs cli/lib/storage-smoke.mjs package.json package-lock.json
git commit -m "feat(cli): cloud provision asks for the storage backend"
```

---

## Phase 8 — Migration command

### Task 16: Add `plannen storage migrate`

One-shot copy of every key in `event_memories.storage_key` from one backend to another. Idempotent — re-running picks up where it left off, using a checkpoint file. Does not flip `PLANNEN_STORAGE_BACKEND` automatically.

**Files:**
- Create: `cli/commands/storage/index.mjs`
- Create: `cli/commands/storage/migrate.mjs`
- Create: `cli/commands/storage/migrate.test.mjs`
- Modify: `cli/index.mjs` (or wherever subcommands are registered)

- [ ] **Step 1: Write the failing test for the core function**

```js
// cli/commands/storage/migrate.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { migrateKeys } from './migrate.mjs';

function adapterStub(initial = new Map()) {
  const store = new Map(initial);
  return {
    store,
    upload: vi.fn(async (key, bytes, _opts) => { store.set(key, bytes); }),
    head: vi.fn(async (key) => store.has(key) ? { size: store.get(key).length, contentType: 'application/octet-stream' } : null),
    delete: vi.fn(async (key) => { const had = store.has(key); store.delete(key); return had; }),
    signedUrl: vi.fn(async (key) => `mock://${key}`),
    downloadBytes: vi.fn(async (key) => store.get(key) ?? null),  // test-only extension
  };
}

describe('migrateKeys', () => {
  it('copies missing keys and skips existing ones', async () => {
    const source = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],
      ['u/e/b.jpg', new Uint8Array([2])],
    ]));
    const target = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],   // already present
    ]));
    const out = await migrateKeys({
      keys: ['u/e/a.jpg', 'u/e/b.jpg'],
      source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out).toEqual({ copied: 1, skipped: 1, failed: 0 });
    expect(target.store.has('u/e/b.jpg')).toBe(true);
  });

  it('skips keys whose target size matches the source', async () => {
    const source = adapterStub(new Map([['u/e/a.jpg', new Uint8Array([1, 2, 3])]]));
    const target = adapterStub(new Map([['u/e/a.jpg', new Uint8Array([1, 2, 3])]]));
    const out = await migrateKeys({
      keys: ['u/e/a.jpg'], source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out).toEqual({ copied: 0, skipped: 1, failed: 0 });
  });

  it('records failures without aborting the run', async () => {
    const source = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],
      ['u/e/b.jpg', new Uint8Array([2])],
    ]));
    const target = adapterStub();
    target.upload.mockImplementationOnce(async () => { throw new Error('boom'); });
    const out = await migrateKeys({
      keys: ['u/e/a.jpg', 'u/e/b.jpg'], source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out.copied).toBe(1);
    expect(out.failed).toBe(1);
  });
});
```

- [ ] **Step 2: Run (expect FAIL)**

Run: `npm test -- migrate.test`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```js
// cli/commands/storage/migrate.mjs
//
// `plannen storage migrate --from supabase --to s3 --profile <name>` copies
// every key in plannen.event_memories.storage_key from the source backend
// to the target backend. Does NOT flip PLANNEN_STORAGE_BACKEND — the
// operator does that manually after the run completes successfully.
//
// Pure core (migrateKeys) is exported for tests; the citty command wires
// it to real adapters + a Postgres pool.

import { defineCommand } from 'citty';
import { composeEnv, getProfileEnvPath } from '../../lib/profiles.mjs';

/**
 * Pure-ish core: walks `keys`, head-checks the target, downloads from source,
 * uploads to target. Returns counts.
 *
 * @param {{
 *   keys: string[],
 *   source: { head(k): Promise<{size:number}|null> },
 *   target: { head(k): Promise<{size:number}|null>, upload(k, bytes, opts): Promise<void> },
 *   downloadFn: (key: string) => Promise<Uint8Array | null>,
 *   onProgress?: (key: string, status: 'copied'|'skipped'|'failed', err?: Error) => void,
 * }} args
 */
export async function migrateKeys({ keys, source, target, downloadFn, onProgress }) {
  let copied = 0, skipped = 0, failed = 0;
  for (const key of keys) {
    try {
      const srcHead = await source.head(key);
      if (!srcHead) {
        // source missing — skip silently (already deleted upstream)
        skipped++;
        onProgress?.(key, 'skipped');
        continue;
      }
      const tgtHead = await target.head(key);
      if (tgtHead && tgtHead.size === srcHead.size) {
        skipped++;
        onProgress?.(key, 'skipped');
        continue;
      }
      const bytes = await downloadFn(key);
      if (!bytes) {
        failed++;
        onProgress?.(key, 'failed', new Error('source returned no bytes'));
        continue;
      }
      await target.upload(key, bytes, {
        contentType: srcHead.contentType ?? 'application/octet-stream',
      });
      copied++;
      onProgress?.(key, 'copied');
    } catch (e) {
      failed++;
      onProgress?.(key, 'failed', e);
    }
  }
  return { copied, skipped, failed };
}

export const storageMigrateCommand = defineCommand({
  meta: { name: 'migrate', description: 'Copy photo bytes between storage backends' },
  args: {
    from: { type: 'string', description: 'Source backend: supabase | s3 | local-fs', required: true },
    to:   { type: 'string', description: 'Target backend: supabase | s3 | local-fs', required: true },
    profile: { type: 'string', description: 'Profile whose env supplies credentials for BOTH backends' },
    'verify-only': { type: 'boolean', description: 'HEAD-compare only, do not upload' },
  },
  async run({ args }) {
    if (args.from === args.to) throw new Error('migrate: --from and --to must differ');
    const env = composeEnv(args.profile ?? process.env.PLANNEN_PROFILE);
    // Build two adapters: source uses --from credentials, target uses --to.
    // For supabase + s3 the same profile env holds both sets (SUPABASE_* and S3_*).
    const { buildAdapterForBackend, buildDownloadFn } = await import('../../lib/storage-runtime.mjs');
    const source = buildAdapterForBackend(args.from, env);
    const target = buildAdapterForBackend(args.to, env);
    const downloadFn = buildDownloadFn(args.from, env, source);

    // Pull the key list from the DB.
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT DISTINCT storage_key FROM plannen.event_memories WHERE storage_key IS NOT NULL ORDER BY storage_key`,
    );
    const keys = rows.map((r) => r.storage_key);
    process.stdout.write(`storage migrate: ${keys.length} key(s) to consider\n`);

    if (args['verify-only']) {
      let mismatch = 0;
      for (const k of keys) {
        const [s, t] = await Promise.all([source.head(k), target.head(k)]);
        if (!t || (s && t.size !== s.size)) mismatch++;
      }
      process.stdout.write(`verify: ${keys.length - mismatch}/${keys.length} present and size-match\n`);
      await pool.end();
      process.exit(mismatch === 0 ? 0 : 1);
    }

    const out = await migrateKeys({
      keys, source, target, downloadFn,
      onProgress: (k, s) => process.stdout.write(`  ${s}\t${k}\n`),
    });
    process.stdout.write(`done: copied=${out.copied} skipped=${out.skipped} failed=${out.failed}\n`);
    await pool.end();
    process.exit(out.failed === 0 ? 0 : 1);
  },
});
```

And the runtime helpers:

```js
// cli/lib/storage-runtime.mjs
//
// Build storage adapters + a backend-specific downloadFn from an env bag.
// Shared by the migrate command and any future operator-side storage tooling.

import { createS3Adapter } from '../../backend/src/_shared/storage/s3.js';
import { createSupabaseAdapter } from '../../backend/src/_shared/storage/supabase.js';
import { createLocalFsAdapter } from '../../backend/src/_shared/storage/localFs.js';
import { BUCKET } from '../../backend/src/_shared/storage/adapter.js';

export function buildAdapterForBackend(name, env) {
  if (name === 'supabase') {
    return createSupabaseAdapter({
      supabaseUrl: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  if (name === 's3') {
    return createS3Adapter({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL ?? '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  if (name === 'local-fs') {
    return createLocalFsAdapter({
      photosRoot: env.PLANNEN_PHOTOS_ROOT,
      originBaseUrl: '',
    });
  }
  throw new Error(`unknown backend: ${name}`);
}

export function buildDownloadFn(name, env, adapter) {
  // Each backend needs a different "give me bytes" path. We can't add a
  // download method to the StorageAdapter interface without bloating it,
  // so this helper centralises the per-backend logic.
  if (name === 'supabase') {
    return async (key) => {
      const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}/${key}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    };
  }
  if (name === 's3') {
    return async (key) => {
      const url = await adapter.signedUrl(key, { ttlSeconds: 900 });
      const res = await fetch(url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    };
  }
  if (name === 'local-fs') {
    return async (key) => {
      const { readFile } = await import('node:fs/promises');
      const { join, resolve } = await import('node:path');
      try {
        return new Uint8Array(await readFile(resolve(env.PLANNEN_PHOTOS_ROOT, BUCKET, key)));
      } catch { return null; }
    };
  }
  throw new Error(`unknown backend: ${name}`);
}
```

- [ ] **Step 4: Register the subcommand**

In `cli/commands/storage/index.mjs`:

```js
import { defineCommand } from 'citty';
import { storageMigrateCommand } from './migrate.mjs';

export const storageCommand = defineCommand({
  meta: { name: 'storage', description: 'Storage tooling' },
  subCommands: { migrate: storageMigrateCommand },
});
```

And wire `storageCommand` into the top-level CLI dispatcher (same shape as the existing `profile`, `cloud`, `functions` subcommands).

- [ ] **Step 5: Run the migrate test (expect PASS)**

Run: `npm test -- migrate.test`
Expected: 3 tests PASS.

- [ ] **Step 6: Smoke against a tiny Tier 1 → S3 migration**

```bash
# in a tier 1 profile that has at least one event_memory with a storage_key
PLANNEN_PROFILE=local-1 npx plannen storage migrate --from supabase --to s3
# inspect: bucket should now have <userId>/<eventId>/<uuid>.jpg
```

- [ ] **Step 7: Commit**

```bash
git add cli/commands/storage/index.mjs cli/commands/storage/migrate.mjs cli/commands/storage/migrate.test.mjs cli/lib/storage-runtime.mjs
git commit -m "feat(cli): plannen storage migrate <--from> <--to> with idempotent copy"
```

---

## Phase 9 — Docs & smoke

### Task 17: Update env documentation and operator docs

**Files:**
- Modify: `.env.example` (if present)
- Modify: `README.md`
- Modify: `docs/INTEGRATIONS.md`

- [ ] **Step 1: Add the new env vars to `.env.example`**

```
# Photo storage backend. One of: local-fs, supabase, s3.
# - local-fs: Tier 0 only, writes under ~/.plannen/photos
# - supabase: Tier 1/2 default, uses Supabase Storage's event-photos bucket
# - s3:       Tier 1/2 opt-in, uses any S3-compatible bucket (R2/Tigris/B2/MinIO)
PLANNEN_STORAGE_BACKEND=supabase

# Required only when PLANNEN_STORAGE_BACKEND=s3:
# S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
# S3_REGION=auto
# S3_BUCKET=plannen-photos
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_PUBLIC_BASE_URL=https://photos.example.com
# S3_FORCE_PATH_STYLE=false
```

- [ ] **Step 2: Add an "S3-compatible storage" section to `docs/INTEGRATIONS.md`**

One short section explaining:
- The three backend values
- Tier 0 is locked to `local-fs`
- How to enable s3 on Tier 1/2 (`plannen profile create --mode=cloud_sb --storage=s3` or the `cloud provision` step)
- The migration command (`plannen storage migrate`)
- That the old Supabase bucket is *not* auto-deleted

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md docs/INTEGRATIONS.md
git commit -m "docs(storage): document PLANNEN_STORAGE_BACKEND and the migration flow"
```

---

### Task 18: End-to-end smoke (manual)

Final acceptance check. The plan is done when these all pass.

- [ ] **Step 1: Tier 0 — local-fs end-to-end**

```bash
npx plannen profile create smoke-t0 --mode=local_pg
npx plannen up --profile smoke-t0
# In the web UI: upload a photo to a new event.
ls ~/.plannen/photos/event-photos/<userId>/<eventId>/
```
Expected: one file with a UUID name.

- [ ] **Step 2: Tier 1 — supabase backend, no behavior change**

```bash
npx plannen profile create smoke-t1 --mode=local_sb
npx plannen up --profile smoke-t1
# Upload a photo via the web UI.
psql "$DATABASE_URL" -c "SELECT storage_key FROM plannen.event_memories ORDER BY created_at DESC LIMIT 1;"
```
Expected: `<userId>/<eventId>/<uuid>.<ext>` shape, file visible in Supabase Studio's event-photos bucket.

- [ ] **Step 3: Tier 2 — fresh provision with s3 backend**

```bash
npx plannen profile create smoke-t2-r2 --mode=cloud_sb --storage=s3
npx plannen cloud provision --profile smoke-t2-r2
# (supply R2 credentials when prompted; expect "S3 credentials verified")
npx plannen deploy --profile smoke-t2-r2
# Open the deployed URL, upload a photo.
```
Verify in the R2 dashboard: the bucket now has `<userId>/<eventId>/<uuid>.<ext>`.

- [ ] **Step 4: Migration — Tier 1 supabase → s3**

```bash
# On an existing supabase-backed profile that already has memories:
npx plannen storage migrate --from supabase --to s3 --profile <prof>
# Then flip the env:
plannen profile env-set <prof> PLANNEN_STORAGE_BACKEND=s3   # (or hand-edit ~/.plannen/profiles/<prof>/env)
npx plannen deploy --profile <prof>
npx plannen storage migrate --from supabase --to s3 --profile <prof> --verify-only
```
Expected: `verify: N/N present and size-match`, exit 0.

- [ ] **Step 5: Tier-0 s3 refusal**

```bash
npx plannen profile create bad --mode=local_pg --storage=s3
```
Expected: exit code != 0, error message mentions `--storage=s3 is not allowed with --mode=local_pg`.

- [ ] **Step 6: Tag & release notes**

```bash
git log --oneline main..HEAD
# Compose release notes mentioning: new PLANNEN_STORAGE_BACKEND knob,
# R2/S3-compatible bucket support, migration command, no behaviour change
# for existing profiles.
```

---

## Out of scope / explicit follow-ups

These are listed in the spec under "Out of scope / follow-up" and are NOT covered by this plan:

- Image transformations (variants at upload time, or Cloudflare Images / imgproxy). Spec recommends fixed-size variants at upload time for v1 — file a separate spec when an actual product requirement appears.
- Lifecycle rules (cold-storage tiers).
- Cross-backend replication / a backup adapter equivalent to `export-seed.sh` for s3.
- Per-event encryption at rest.
- Updating `scripts/lib/storage-cloud-upload.mjs` and `scripts/lib/dump-cloud-photos.mjs` to know about s3 sources/destinations — the new `plannen storage migrate` command supersedes them for migrations; the dump/restore scripts can be extended in a follow-up spec when an s3-backed deployment first needs a `export-seed.sh` equivalent.
- Updating the Deno MCP tool variant `supabase/functions/mcp/tools/photos.ts` — it constructs a Supabase-shaped publicUrl that today's frontend reads. The same `storage_key` shim landed in Task 11 for the picker handler is appropriate here too, but the tool is invoked only by Claude (not the web UI) and its callers don't depend on backend-agnostic URLs yet. Track separately when the MCP tools also need to work against an s3 backend.
- A Vercel-served `/api/photos/*` for Tier 2 + s3 frontends that route through Vercel's edge instead of the Hono backend. Today the Tier 2 frontend can call the Hono backend directly via `PLANNEN_BACKEND_URL`; a Vercel-native variant becomes a follow-up if Tier 2 wants to drop the Hono backend.
