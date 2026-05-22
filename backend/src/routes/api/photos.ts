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
    // Storage without holding any service credential.
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
