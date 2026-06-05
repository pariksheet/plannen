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
