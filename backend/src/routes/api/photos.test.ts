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
      `INSERT INTO plannen.events (title, created_by, start_date, event_status)
       VALUES ('photos-api test', $1, now(), 'going') RETURNING id`,
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
        `INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'photos-api-other@plannen.local')
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      )
      otherUid = r.rows[0].id
      const e = await c.query(
        `INSERT INTO plannen.events (title, created_by, start_date, event_status) VALUES ('x', $1, now(), 'going') RETURNING id`,
        [otherUid],
      )
      const res = await app.request('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: e.rows[0].id, filename: 'a.jpg', content_type: 'image/jpeg' }),
      })
      expect(res.status).toBe(403)
    } finally {
      if (otherUid) {
        await c.query(`DELETE FROM plannen.users WHERE id = $1`, [otherUid])
        await c.query(`DELETE FROM auth.users WHERE id = $1`, [otherUid])
      }
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
