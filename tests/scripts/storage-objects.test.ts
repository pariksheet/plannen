import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module, no type defs
import { synthesize } from '../../scripts/lib/storage-objects.mjs'

const fixedUuid = (n: number) => () => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe('synthesize', () => {
  it('emits one row + one layout entry for a single file', () => {
    const out = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'eid/uid/file.jpg',
          size: 1024,
          mimetype: 'image/jpeg',
          owner: '0f387111-8482-41e2-8444-59f66949ffdd',
          etag: 'd6eb32081c822ed572b70567826d9d9d',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
      ],
      { uuid: fixedUuid(1) },
    )

    expect(out.rows).toHaveLength(1)
    expect(out.layout).toHaveLength(1)
  })

  it('builds storage.objects row with all required columns', () => {
    const { rows } = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'eid/uid/file.jpg',
          size: 1024,
          mimetype: 'image/jpeg',
          owner: '0f387111-8482-41e2-8444-59f66949ffdd',
          etag: 'd6eb32081c822ed572b70567826d9d9d',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
      ],
      { uuid: fixedUuid(1) },
    )

    expect(rows[0]).toMatchObject({
      bucket_id: 'event-photos',
      name: 'eid/uid/file.jpg',
      owner: '0f387111-8482-41e2-8444-59f66949ffdd',
      owner_id: '0f387111-8482-41e2-8444-59f66949ffdd',
      created_at: '2026-05-15T18:10:32.170Z',
      updated_at: '2026-05-15T18:10:32.170Z',
      last_accessed_at: '2026-05-15T18:10:32.170Z',
      user_metadata: {},
    })
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].version).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('wraps eTag in quotes inside metadata', () => {
    const { rows } = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'a/b/c.jpg',
          size: 2048,
          mimetype: 'image/jpeg',
          owner: null,
          etag: 'abc123',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
      ],
      { uuid: fixedUuid(2) },
    )

    expect(rows[0].metadata).toEqual({
      eTag: '"abc123"',
      size: 2048,
      mimetype: 'image/jpeg',
      cacheControl: 'max-age=3600',
      lastModified: '2026-05-15T18:10:32.170Z',
      contentLength: 2048,
      httpStatusCode: 200,
    })
  })

  it('places the file under the version-uuid leaf in the layout', () => {
    const { rows, layout } = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'eid/uid/file.jpg',
          size: 1024,
          mimetype: 'image/jpeg',
          owner: null,
          etag: 'x',
          lastModified: '2026-05-15T18:10:32.170Z',
          srcAbsPath: '/photos/eid/uid/file.jpg',
        },
      ],
      { uuid: fixedUuid(1) },
    )

    expect(layout[0]).toEqual({
      srcAbsPath: '/photos/eid/uid/file.jpg',
      destRelPath: `stub/stub/event-photos/eid/uid/file.jpg/${rows[0].version}`,
    })
  })

  it('handles null owner without setting owner_id', () => {
    const { rows } = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'a/b/c.jpg',
          size: 100,
          mimetype: 'image/jpeg',
          owner: null,
          etag: 'x',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
      ],
      { uuid: fixedUuid(3) },
    )

    expect(rows[0].owner).toBeNull()
    expect(rows[0].owner_id).toBeNull()
  })

  it('processes multiple files independently', () => {
    let counter = 0
    const seqUuid = () => `00000000-0000-0000-0000-${String(++counter).padStart(12, '0')}`

    const { rows, layout } = synthesize(
      [
        {
          bucket: 'event-photos',
          path: 'e1/u/a.jpg',
          size: 1,
          mimetype: 'image/jpeg',
          owner: null,
          etag: 'a',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
        {
          bucket: 'event-photos',
          path: 'e2/u/b.jpg',
          size: 2,
          mimetype: 'image/jpeg',
          owner: null,
          etag: 'b',
          lastModified: '2026-05-15T18:10:32.170Z',
        },
      ],
      { uuid: seqUuid },
    )

    expect(rows.map((r: any) => r.name)).toEqual(['e1/u/a.jpg', 'e2/u/b.jpg'])
    // each row gets a unique version, used as the leaf-dir in its layout
    expect(rows[0].version).not.toEqual(rows[1].version)
    expect(layout[0].destRelPath).toContain(rows[0].version)
    expect(layout[1].destRelPath).toContain(rows[1].version)
  })

  it('returns empty arrays for empty input', () => {
    const { rows, layout } = synthesize([], { uuid: fixedUuid(1) })
    expect(rows).toEqual([])
    expect(layout).toEqual([])
  })
})
