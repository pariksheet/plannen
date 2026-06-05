import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'

let photosRoot: string
let app: ReturnType<typeof buildApp>
const testEmail = 'photos-test@plannen.local'
let testUserId: string

beforeAll(async () => {
  photosRoot = mkdtempSync(join(tmpdir(), 'plannen-photos-'))
  process.env.PLANNEN_PHOTOS_ROOT = photosRoot
  const c = await pool.connect()
  try {
    const existing = await c.query(
      'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
      [testEmail],
    )
    if (existing.rows.length > 0) {
      testUserId = existing.rows[0].id
    } else {
      const inserted = await c.query(
        'INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id',
        [testEmail],
      )
      testUserId = inserted.rows[0].id
    }
  } finally {
    c.release()
  }
  app = buildApp({ userId: testUserId, userEmail: testEmail })
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
})

describe('storage event-photos', () => {
  it('PUT then GET roundtrips a binary', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const put = await app.request(
      `/storage/v1/object/event-photos/${testUserId}/test.png`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body,
      },
    )
    expect(put.status).toBe(200)
    const putJson = (await put.json()) as { data: { Key: string } }
    expect(putJson.data.Key).toBe(`event-photos/${testUserId}/test.png`)

    expect(
      existsSync(join(photosRoot, 'event-photos', testUserId, 'test.png')),
    ).toBe(true)
    expect(
      readFileSync(join(photosRoot, 'event-photos', testUserId, 'test.png')),
    ).toEqual(Buffer.from(body))

    const get = await app.request(
      `/storage/v1/object/public/event-photos/${testUserId}/test.png`,
    )
    expect(get.status).toBe(200)
    const got = new Uint8Array(await get.arrayBuffer())
    expect(got).toEqual(body)
    expect(get.headers.get('content-type')).toContain('image/png')
  })

  it('DELETE removes the file', async () => {
    const body = new Uint8Array([1, 2, 3])
    await app.request(
      `/storage/v1/object/event-photos/${testUserId}/del.bin`,
      { method: 'PUT', body },
    )
    const del = await app.request(
      `/storage/v1/object/event-photos/${testUserId}/del.bin`,
      { method: 'DELETE' },
    )
    expect(del.status).toBe(200)
    expect(
      existsSync(join(photosRoot, 'event-photos', testUserId, 'del.bin')),
    ).toBe(false)
  })

  it('rejects path traversal', async () => {
    const res = await app.request(
      `/storage/v1/object/event-photos/..%2F..%2Fetc%2Fpasswd`,
      { method: 'PUT', body: new Uint8Array([0]) },
    )
    expect(res.status).toBe(400)
  })

  it('404 for missing file', async () => {
    const res = await app.request(
      `/storage/v1/object/public/event-photos/nonexistent/x.png`,
    )
    expect(res.status).toBe(404)
  })
})
