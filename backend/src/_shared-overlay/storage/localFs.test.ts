import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalFsAdapter } from './localFs.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plannen-localfs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('localFs adapter', () => {
  it('upload then head returns size + content-type', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    const bytes = new Uint8Array([1, 2, 3, 4])
    await adapter.upload('user-1/event-1/abc.jpg', bytes, { contentType: 'image/jpeg' })
    expect(existsSync(join(root, 'event-photos', 'user-1/event-1/abc.jpg'))).toBe(true)
    const head = await adapter.head('user-1/event-1/abc.jpg')
    expect(head).toEqual({ size: 4, contentType: 'image/jpeg' })
  })

  it('delete returns true for existing object, false for missing', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    await adapter.upload('user-1/event-1/a.bin', new Uint8Array([0]), { contentType: 'application/octet-stream' })
    expect(await adapter.delete('user-1/event-1/a.bin')).toBe(true)
    expect(await adapter.delete('user-1/event-1/a.bin')).toBe(false)
  })

  it('signedUrl returns an origin-relative path under the public mirror', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://127.0.0.1:54323' })
    const url = await adapter.signedUrl('user-1/event-1/a.jpg', { ttlSeconds: 3600 })
    expect(url).toBe('http://127.0.0.1:54323/storage/v1/object/public/event-photos/user-1/event-1/a.jpg')
  })

  it('rejects path traversal', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    await expect(adapter.upload('../etc/passwd', new Uint8Array([0]), { contentType: 'x' }))
      .rejects.toThrow(/key/i)
  })

  it('head returns null for missing object', async () => {
    const adapter = createLocalFsAdapter({ photosRoot: root, originBaseUrl: 'http://x' })
    expect(await adapter.head('nope/missing.jpg')).toBeNull()
  })
})
