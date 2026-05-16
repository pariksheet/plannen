import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import { mimeFromPath, inventoryPhotos } from '../../scripts/lib/migrate-tier0-to-tier1.mjs'

describe('mimeFromPath', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeFromPath('a.jpg')).toBe('image/jpeg')
    expect(mimeFromPath('A.JPG')).toBe('image/jpeg')
    expect(mimeFromPath('foo/bar/baz.heic')).toBe('image/heic')
    expect(mimeFromPath('clip.mp4')).toBe('video/mp4')
    expect(mimeFromPath('voice.m4a')).toBe('audio/mp4')
  })

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeFromPath('mystery.xyz')).toBe('application/octet-stream')
    expect(mimeFromPath('noext')).toBe('application/octet-stream')
  })
})

describe('inventoryPhotos', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-inv-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function placeFile(rel: string, content = 'hello', mtimeIso?: string) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    if (mtimeIso) {
      const t = new Date(mtimeIso)
      utimesSync(abs, t, t)
    }
  }

  it('returns [] when the photos root does not exist', () => {
    expect(inventoryPhotos(join(root, 'missing'))).toEqual([])
  })

  it('inventories a single file with derived path, etag, owner, mimetype', () => {
    placeFile('event-photos/eid-1/uid-1/picture.jpg', 'hello', '2026-05-15T18:10:32.170Z')

    const out = inventoryPhotos(root)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      bucket: 'event-photos',
      path: 'eid-1/uid-1/picture.jpg',
      owner: 'uid-1',
      mimetype: 'image/jpeg',
      size: 5,
      lastModified: '2026-05-15T18:10:32.170Z',
      // md5('hello') = 5d41402abc4b2a76b9719d911017c592
      etag: '5d41402abc4b2a76b9719d911017c592',
    })
    expect(out[0].srcAbsPath.endsWith('event-photos/eid-1/uid-1/picture.jpg')).toBe(true)
  })

  it('walks multiple events and owners', () => {
    placeFile('event-photos/e1/u1/a.jpg')
    placeFile('event-photos/e1/u1/b.heic')
    placeFile('event-photos/e1/u2/c.png')
    placeFile('event-photos/e2/u1/d.mp4')

    const out = inventoryPhotos(root)
    const paths = out.map((o: any) => o.path).sort()

    expect(paths).toEqual([
      'e1/u1/a.jpg',
      'e1/u1/b.heic',
      'e1/u2/c.png',
      'e2/u1/d.mp4',
    ])
  })

  it('ignores buckets other than event-photos', () => {
    placeFile('event-photos/e1/u1/keep.jpg')
    placeFile('thumbnails/e1/u1/skip.jpg')

    const out = inventoryPhotos(root)
    expect(out.map((o: any) => o.path)).toEqual(['e1/u1/keep.jpg'])
  })

  it('ignores stray non-directory entries at each level', () => {
    placeFile('event-photos/.DS_Store')               // file in bucket
    placeFile('event-photos/e1/.DS_Store')            // file in event dir
    placeFile('event-photos/e1/u1/keep.jpg')          // the real file

    const out = inventoryPhotos(root)
    expect(out.map((o: any) => o.path)).toEqual(['e1/u1/keep.jpg'])
  })
})
