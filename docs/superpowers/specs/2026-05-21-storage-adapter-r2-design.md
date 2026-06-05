# Storage Adapter (R2 / S3-compatible)

**Date:** 2026-05-21
**Type:** New feature — adds a storage-backend choice as a per-profile setting.
**Status:** Approved (design) — implementation plan pending.
**Branch:** `feat/storage_adapter_r2`

## Problem

Supabase Storage is the default photo bucket for Tier 1 and Tier 2 today. Its cost surface is dominated by **egress at $0.09/GB**. For a family-photo app with social/share semantics, egress scales with users, not with stored bytes — that's the wrong cost shape.

There is no operator-facing knob to point storage at a cheaper backend. Tier 0 already writes to local disk (`~/.plannen/photos`) via a Hono mirror of Supabase Storage's REST surface (`backend/src/routes/storage/eventPhotos.ts`). Tier 1/2 always go to Supabase Storage. The choice is implicit in the tier, not configurable.

We want any deployer — including the hosted Plannen SaaS — to be able to flip storage onto an S3-compatible backend (Cloudflare R2, Tigris, Backblaze B2, MinIO) without changing tier or rewriting application code. **R2 in particular has zero egress, which removes the dominant cost.**

## Decision

Add a per-profile setting `PLANNEN_STORAGE_BACKEND` with three values:

| Value | When | Backend |
|---|---|---|
| `local-fs` | Tier 0 only — forced | `~/.plannen/photos` via Hono mirror (today's behaviour) |
| `supabase` | Tier 1/2 default | Supabase Storage (today's behaviour) |
| `s3` | Tier 1/2 opt-in | S3-compatible bucket (R2, Tigris, B2, MinIO, …) |

**Default per tier stays the same** — no existing deployment changes behaviour. Opting into `s3` requires adding S3 credentials to the profile env and (one-time) running a migration script.

**Tier 0 is locked to `local-fs`.** Tier 0 is the single-user local mode — putting bytes into a remote bucket conflicts with that model (network dependency, credentials a local user shouldn't need, breaks the "everything under `~/.plannen/`" guarantee). `plannen profile create --mode=local_pg --storage s3` is refused at profile-create time with a clear error.

### Why S3-compatible covers R2/Tigris/B2/MinIO in one adapter

R2, Tigris, Backblaze B2, DigitalOcean Spaces, Wasabi, and MinIO all speak the S3 API. `@aws-sdk/client-s3` works against all of them by changing `endpoint` and `region`. We do not need a separate "R2 adapter" — we need one S3-compatible adapter pointed at R2 by default.

### Why this is a profile setting, not a runtime choice

Photos are addressed by stable keys stored in the DB. Within one deployment, all photos must live in the same backend so that a single `event_photos` row resolves to one bucket. Per-user choice would require a `backend` column on every row and break shared/social events. **Profile-level is the right granularity.**

## End-state

### Profile env additions

Profile env file (`~/.plannen/profiles/<name>/env`) gains:

```
PLANNEN_STORAGE_BACKEND=supabase   # default for cloud_sb / local_sb
# PLANNEN_STORAGE_BACKEND=local-fs # default for local_pg
# PLANNEN_STORAGE_BACKEND=s3       # opt-in

# Required only when PLANNEN_STORAGE_BACKEND=s3:
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto                              # 'auto' for R2; matches provider for others
S3_BUCKET=plannen-photos
S3_ACCESS_KEY_ID=<r2-access-key-id>
S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
S3_PUBLIC_BASE_URL=https://photos.example.com   # custom domain OR https://pub-<hash>.r2.dev
S3_FORCE_PATH_STYLE=false                   # true for MinIO, false for R2/Tigris/B2
```

`plannen profile create` accepts `--storage <local-fs|supabase|s3>` and prompts for S3 fields when `s3` is chosen.

### Adapter interface

New file: `backend/src/_shared/storage/adapter.ts`

```ts
export interface UploadOptions {
  contentType: string
  cacheControl?: string  // defaults to 'private, max-age=3600'
}

export interface SignedUrlOptions {
  ttlSeconds: number     // 60..86400
  download?: boolean     // if true, Content-Disposition: attachment
}

export interface HeadResult {
  size: number
  contentType: string
  etag?: string
}

export interface StorageAdapter {
  /** Upload bytes to `key`. Overwrites existing object. */
  upload(key: string, body: Uint8Array | ReadableStream, opts: UploadOptions): Promise<void>

  /** Idempotent delete. Returns false if the object did not exist. */
  delete(key: string): Promise<boolean>

  /** Returns a URL the client can GET directly. Backend-specific (signed for S3, public for Supabase, backend route for local-fs). */
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>

  /** Returns object metadata, or null if it doesn't exist. */
  head(key: string): Promise<HeadResult | null>
}
```

Three implementations:

- `backend/src/_shared/storage/localFs.ts` — wraps the existing logic in `routes/storage/eventPhotos.ts` (extracted, not duplicated). `signedUrl` returns a same-origin backend URL.
- `backend/src/_shared/storage/supabase.ts` — wraps `supabaseAdmin.storage.from(...)`. `signedUrl` uses `createSignedUrl(key, ttl)`.
- `backend/src/_shared/storage/s3.ts` — uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. `signedUrl` returns a presigned `GetObjectCommand` URL.

A factory `getStorage(): StorageAdapter` reads `PLANNEN_STORAGE_BACKEND` once at boot and returns the appropriate instance.

### Canonical key shape

Keys stored in the `event_photos.storage_key` column have **no backend prefix**:

```
<user_id>/<event_id>/<uuid>.<ext>
```

The Supabase adapter prepends `event-photos/` (the bucket name). The S3 adapter writes under the configured `S3_BUCKET`. The local-fs adapter writes under `<photosRoot>/event-photos/`. **The DB row never encodes the backend.** This makes migration a copy operation, not a row rewrite.

### Auth model per backend

| Backend | Read auth | Write auth |
|---|---|---|
| `local-fs` | Hono route checks `auth.uid()` against `event_photos.owner_id` (or shared via `event_shares`), then streams the file. | Hono route checks owner before PUT. |
| `supabase` | Existing RLS-on-bucket policies (kept as-is for backward compatibility). | RLS-on-bucket. |
| `s3` | Backend endpoint `GET /api/photos/signed-url?key=…` checks `auth.uid()` against the DB row, then mints a 15-min presigned URL. | Backend endpoint `POST /api/photos/upload-url?key=…` checks ownership intent, then mints a 15-min presigned `PutObjectCommand` URL. Client uploads directly to R2. |

This means **the S3 path adds two small backend endpoints** for URL minting — they replace the implicit RLS check Supabase Storage does inline. Frontend code calls `storageClient.uploadUrl(key)` / `storageClient.downloadUrl(key)` instead of constructing Supabase Storage URLs directly.

### Frontend client abstraction

New file: `src/lib/storageClient.ts`

```ts
// One client used by all UI code. Hides the backend choice.
export const storageClient = {
  async upload(key: string, file: Blob): Promise<void> { /* fetches upload URL, PUTs */ },
  async downloadUrl(key: string): Promise<string> { /* fetches signed URL */ },
  async delete(key: string): Promise<void> { /* fetches delete URL or calls backend */ },
}
```

Implementation calls `/api/photos/upload-url` and `/api/photos/signed-url` regardless of backend. The backend handles the per-backend translation. **No frontend code knows whether the bytes live in Supabase, R2, or local disk.**

## Touch points

Files to update (from grep against `storage.from`, `event-photos`, `createSignedUrl`):

**Backend / functions:**
- `backend/src/routes/storage/eventPhotos.ts` — extract local-fs logic into adapter; keep route as thin wrapper for backward compat
- `backend/src/routes/api/memories.ts` — replace direct storage calls with adapter
- `backend/src/_shared/handlers/picker-session-poll.ts` — Google Photos download → adapter.upload
- `supabase/functions/_shared/handlers/picker-session-poll.ts` — same fix for the Deno edge-function variant
- `supabase/functions/mcp/tools/photos.ts` — replace direct storage calls
- New: `backend/src/_shared/storage/{adapter,localFs,supabase,s3,factory}.ts`
- New: `backend/src/routes/api/photos/uploadUrl.ts`, `signedUrl.ts`

**Frontend:**
- `src/services/eventCoverService.ts` — replace direct `getPublicUrl`/`createSignedUrl` with `storageClient.downloadUrl`
- `src/lib/dbClient/tier0.ts` / `tier1.ts` — drop storage helpers, defer to `storageClient`
- New: `src/lib/storageClient.ts`

**Scripts:**
- `scripts/lib/storage-cloud-upload.mjs` — gain `--backend s3` mode
- `scripts/lib/dump-cloud-photos.mjs` — gain s3 source support
- `scripts/lib/restore-photos.mjs` — gain s3 destination support
- New: `cli/commands/storage/migrate.mjs` — `plannen storage migrate --from supabase --to s3`

**CLI:**
- `cli/lib/profiles.mjs` — `runtimeEnvFor` learns about `PLANNEN_STORAGE_BACKEND` and S3_* keys; defaults per mode
- `cli/commands/profile/create.mjs` — `--storage` flag + interactive prompt for S3 fields
- `cli/commands/cloud/provision.mjs` — gain a "which storage backend?" step (default: `supabase`)

**Tests:**
- `tests/scripts/storage-objects.test.ts` — extend with s3 adapter
- `tests/scripts/storage-cloud-upload.test.ts` — extend with s3 mode
- New: `backend/src/_shared/storage/*.test.ts` — one suite per adapter using a MinIO container (or aws-sdk-mock for unit-level)

## Migration

### New deployments
Set `PLANNEN_STORAGE_BACKEND=s3` plus S3_* keys in the profile env before first deploy. Nothing else needed.

### Existing deployments switching to S3

One-time CLI:

```
npx plannen storage migrate --from supabase --to s3 --profile <name>
```

Behaviour:
1. Verify both source (`PLANNEN_STORAGE_BACKEND=supabase` currently) and target S3_* credentials work.
2. List all `event_photos.storage_key` rows.
3. For each key: `head` on target — if exists with matching size, skip. Else: download from source, upload to target.
4. Run a sample-set checksum verify (random 5% of keys, full byte compare).
5. Print a summary; do **not** flip `PLANNEN_STORAGE_BACKEND` automatically.
6. Operator manually flips the env var, redeploys, and runs the migration command again with `--verify-only` to confirm post-cutover.

Idempotent: re-running picks up where it left off. Old Supabase bucket is **not deleted** by the migrate command — keep it for at least one rollback window.

## Open questions

1. **Image transformations.** Supabase Storage has a built-in image-transform endpoint (resize, format). R2 does not. Two options when `backend=s3`:
   - (a) Generate fixed-size variants at upload time (`-thumb.jpg`, `-medium.jpg`, original).
   - (b) Add Cloudflare Images / imgproxy as a separate concern.
   Recommend (a) for v1 — simpler, no extra dep.

2. **Picker download path.** The Google Photos picker poll handler currently downloads each picked media into Supabase Storage. After this change, it downloads into whichever backend the profile names. Confirm this still completes within the picker session's ~60min `baseUrl` TTL for typical batch sizes (it does — but flag for review).

3. **Anonymous read URLs.** Public events (if any) currently rely on Supabase's public bucket URLs. With S3, we mint short-lived signed URLs even for public content, which breaks long-lived link sharing. Acceptable for v1 — public share links are out of scope of Plannen today; revisit if needed.

## Out of scope / follow-up

- **Lifecycle rules.** Cold-storage tier for old photos (R2 Infrequent Access, B2 lifecycle).
- **Cross-backend replication.** If we want geographic redundancy, that's a separate spec.
- **Backup adapter** (e.g. nightly mirror to a second bucket). Today `export-seed.sh` handles this for Supabase; the s3 backend would need its own mirror step.
- **Per-event encryption at rest.** Future work; tied to social-sharing privacy.

## Tier 0 implication (clarification)

Tier 0 today uses the Hono mirror at `backend/src/routes/storage/eventPhotos.ts`. After this change, that route delegates to the `local-fs` adapter — same disk layout, same path-traversal guard, same REST surface. The mirror route stays for backward compatibility with code that hardcodes the Supabase Storage REST path; new code uses `storageClient` and the `/api/photos/*` endpoints.
