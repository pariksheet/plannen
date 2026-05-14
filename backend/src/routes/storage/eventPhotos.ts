// Mirror of Supabase Storage's REST surface for the `event-photos` bucket.
//
// Tier 1 (Supabase) URL                            → Tier 0 mapping
//   PUT  /storage/v1/object/event-photos/<key>     → writes file under PLANNEN_PHOTOS_ROOT/event-photos/<key>
//   GET  /storage/v1/object/public/event-photos/<k>→ reads same file
//   DELETE /storage/v1/object/event-photos/<key>   → unlinks (idempotent)
//
// Path traversal guard: decoded URL must resolve inside PLANNEN_PHOTOS_ROOT.

import { Hono } from 'hono'
import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  stat,
} from 'node:fs/promises'
import { resolve, join, dirname, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const eventPhotos = new Hono<{ Variables: AppVariables }>()

const photosRoot = () =>
  resolve(process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'))

function safePath(relative: string): string {
  const root = photosRoot()
  const decoded = decodeURIComponent(relative)
  const candidate = resolve(root, decoded)
  if (!candidate.startsWith(root + sep) && candidate !== root) {
    throw new HttpError(400, 'INVALID_PATH', 'Path traversal blocked')
  }
  return candidate
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

// PUT /storage/v1/object/event-photos/<path> — upload
eventPhotos.put('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/event-photos/'
  const idx = url.pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const relative = url.pathname.slice(idx + prefix.length)
  if (!relative) throw new HttpError(400, 'INVALID_PATH', 'Missing path')

  const target = safePath(`event-photos/${relative}`)
  await mkdir(dirname(target), { recursive: true })
  const body = new Uint8Array(await c.req.arrayBuffer())
  await writeFile(target, body)
  return c.json({ data: { Key: `event-photos/${relative}` } })
})

// GET /storage/v1/object/public/event-photos/<path> — serve
eventPhotos.get('/public/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/public/event-photos/'
  const idx = url.pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const relative = url.pathname.slice(idx + prefix.length)
  const target = safePath(`event-photos/${relative}`)
  try {
    await stat(target)
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'File not found')
  }
  const data = await readFile(target)
  const ct = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  return new Response(data, { headers: { 'Content-Type': ct } })
})

// DELETE /storage/v1/object/event-photos/<path>
eventPhotos.delete('/event-photos/*', async (c) => {
  const url = new URL(c.req.url)
  const prefix = '/storage/v1/object/event-photos/'
  const idx = url.pathname.indexOf(prefix)
  if (idx === -1) throw new HttpError(400, 'INVALID_PATH', 'Bad path')
  const relative = url.pathname.slice(idx + prefix.length)
  const target = safePath(`event-photos/${relative}`)
  try {
    await unlink(target)
  } catch {
    // Idempotent: missing file is success.
  }
  return c.json({ data: { Key: `event-photos/${relative}` } })
})
