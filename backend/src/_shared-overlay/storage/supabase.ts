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
