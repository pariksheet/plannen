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
