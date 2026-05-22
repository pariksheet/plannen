// supabase/functions/_shared/storage/adapter.ts
//
// Deno-side mirror of the StorageAdapter interface used by the Node backend
// at backend/src/_shared-overlay/storage/adapter.ts. Edge functions ONLY
// need the supabase backend (local-fs/s3 require the Node backend) — the
// interface itself is identical so handler code can be shared.

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
   * - supabase: createSignedUrl via Storage REST API
   * - local-fs: not supported in Deno edge runtime
   * - s3: not supported in Deno edge runtime
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
