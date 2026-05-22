// backend/src/_shared-overlay/storage/localFs.ts
//
// File-system implementation of StorageAdapter. Replaces the inline logic
// previously in routes/storage/eventPhotos.ts; the route now delegates here.
//
// signedUrl() returns a same-origin URL pointing at the public mirror
// route — this is NOT a cryptographically signed URL. Tier 0 is
// single-user and the route lives behind the same auth middleware as
// every other backend call, so a signed wrapper would be theatre.

import { mkdir, writeFile, unlink, stat } from 'node:fs/promises'
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
