// supabase/functions/_shared/storage/supabase.ts
//
// Deno-side mirror of the Supabase Storage REST adapter. Functionally
// identical to backend/src/_shared-overlay/storage/supabase.ts — both run
// the same REST calls; only the import suffix differs (.ts vs .js).
//
// Talks to Supabase's Storage REST API directly via fetch (no
// @supabase/supabase-js dep). Uses the service-role key so the backend can
// mint signed URLs without re-implementing RLS.

import type { StorageAdapter, UploadOptions, SignedUrlOptions, HeadResult } from './adapter.ts'
import { BUCKET, assertCanonicalKey } from './adapter.ts'

export interface SupabaseAdapterOptions {
  supabaseUrl: string
  serviceRoleKey: string
  /** Override fetch (used by tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function createSupabaseAdapter(opts: SupabaseAdapterOptions): StorageAdapter {
  const base = opts.supabaseUrl.replace(/\/+$/, '')
  const storageBase = `${base}/storage/v1`
  const f = opts.fetchImpl ?? fetch
  const auth = { authorization: `Bearer ${opts.serviceRoleKey}` }

  function objectUrl(key: string): string {
    return `${storageBase}/object/${BUCKET}/${key}`
  }

  return {
    async upload(key, body, options: UploadOptions) {
      assertCanonicalKey(key)
      // Go through ArrayBuffer + Blob so the body is a `BodyInit` under both
      // Deno's lib and the Node-side TS that prepare-shared re-checks against.
      // Routing through Response.arrayBuffer() guarantees a real ArrayBuffer
      // (not ArrayBufferLike / potentially SharedArrayBuffer), which is what
      // Blob's BlobPart contract demands. It also handles subarray views
      // correctly — `bytes.buffer` would leak unrelated bytes for a narrow view.
      // `body` is `Uint8Array | ReadableStream<Uint8Array>` per the adapter
      // contract — both are valid BodyInit at runtime, but TS's stricter
      // typings see the Uint8Array's buffer as `ArrayBufferLike` rather than
      // the `ArrayBuffer` that the Response constructor demands.
      const ab = await new Response(body as BodyInit).arrayBuffer()
      const res = await f(objectUrl(key), {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': options.contentType,
          'cache-control': options.cacheControl ?? 'private, max-age=3600',
          'x-upsert': 'true',
        },
        body: new Blob([ab], { type: options.contentType }),
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
      const res = await f(`${storageBase}/object/sign/${BUCKET}/${key}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: urlOpts.ttlSeconds }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): sign failed ${res.status} ${detail}`)
      }
      const body = await res.json() as { signedURL?: string }
      if (!body.signedURL) throw new Error('storage(supabase): sign returned no signedURL')
      let url = `${storageBase}${body.signedURL}`
      if (urlOpts.download) {
        url += url.includes('?') ? '&download=' : '?download='
      }
      return url
    },

    async head(key): Promise<HeadResult | null> {
      assertCanonicalKey(key)
      // Supabase Storage doesn't expose a true HEAD; use the info endpoint.
      const res = await f(`${storageBase}/object/info/${BUCKET}/${key}`, {
        method: 'GET',
        headers: auth,
      })
      if (res.status === 404) return null
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`storage(supabase): info failed ${res.status} ${detail}`)
      }
      const body = await res.json() as {
        size?: number
        content_type?: string
        contentType?: string
        mimetype?: string
        etag?: string
      }
      return {
        size: body.size ?? 0,
        contentType: body.content_type ?? body.contentType ?? body.mimetype ?? 'application/octet-stream',
        etag: body.etag,
      }
    },
  }
}
