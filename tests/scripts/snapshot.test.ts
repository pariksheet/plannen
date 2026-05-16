import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import { timestampForFilename, prune } from '../../scripts/lib/snapshot.mjs'

describe('timestampForFilename', () => {
  it('formats a Date as ISO with colons replaced by hyphens', () => {
    const out = timestampForFilename(new Date('2026-05-16T10:01:00.000Z'))
    expect(out).toBe('2026-05-16T10-01-00Z')
  })

  it('drops sub-second precision', () => {
    const out = timestampForFilename(new Date('2026-05-16T10:01:00.123Z'))
    expect(out).toBe('2026-05-16T10-01-00Z')
  })

  it('always uses UTC', () => {
    // 2026-05-16T10:01 in UTC is the canonical answer regardless of host TZ
    const out = timestampForFilename(new Date('2026-05-16T10:01:00Z'))
    expect(out).toBe('2026-05-16T10-01-00Z')
  })
})

describe('prune', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plannen-snapshot-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeSnapshot(stamp: string, mtimeIso: string) {
    const sql = join(dir, `${stamp}.sql.gz`)
    const photos = join(dir, `${stamp}-photos.tar.gz`)
    writeFileSync(sql, 'sql')
    writeFileSync(photos, 'photos')
    const mtime = new Date(mtimeIso)
    utimesSync(sql, mtime, mtime)
    utimesSync(photos, mtime, mtime)
  }

  it('keeps the most recent N by mtime, deletes the rest', () => {
    makeSnapshot('2026-05-10T09-00-00Z', '2026-05-10T09:00:00Z')
    makeSnapshot('2026-05-11T09-00-00Z', '2026-05-11T09:00:00Z')
    makeSnapshot('2026-05-12T09-00-00Z', '2026-05-12T09:00:00Z')
    makeSnapshot('2026-05-13T09-00-00Z', '2026-05-13T09:00:00Z')

    prune(dir, 2)

    const remaining = readdirSync(dir).sort()
    expect(remaining).toEqual([
      '2026-05-12T09-00-00Z-photos.tar.gz',
      '2026-05-12T09-00-00Z.sql.gz',
      '2026-05-13T09-00-00Z-photos.tar.gz',
      '2026-05-13T09-00-00Z.sql.gz',
    ])
  })

  it('is a no-op when count is below the keep threshold', () => {
    makeSnapshot('2026-05-10T09-00-00Z', '2026-05-10T09:00:00Z')
    makeSnapshot('2026-05-11T09-00-00Z', '2026-05-11T09:00:00Z')

    prune(dir, 5)

    expect(readdirSync(dir)).toHaveLength(4)
  })

  it('deletes the .sql.gz even when its photos sibling is missing', () => {
    // A half-finished snapshot (sql written, photos failed) should still be pruned.
    const old = join(dir, '2026-05-10T09-00-00Z.sql.gz')
    writeFileSync(old, 'sql')
    utimesSync(old, new Date('2026-05-10T09:00:00Z'), new Date('2026-05-10T09:00:00Z'))
    makeSnapshot('2026-05-13T09-00-00Z', '2026-05-13T09:00:00Z')
    makeSnapshot('2026-05-14T09-00-00Z', '2026-05-14T09:00:00Z')

    prune(dir, 2)

    expect(readdirSync(dir).sort()).toEqual([
      '2026-05-13T09-00-00Z-photos.tar.gz',
      '2026-05-13T09-00-00Z.sql.gz',
      '2026-05-14T09-00-00Z-photos.tar.gz',
      '2026-05-14T09-00-00Z.sql.gz',
    ])
  })

  it('ignores non-snapshot files in the directory', () => {
    writeFileSync(join(dir, 'README'), 'note')
    makeSnapshot('2026-05-13T09-00-00Z', '2026-05-13T09:00:00Z')
    makeSnapshot('2026-05-14T09-00-00Z', '2026-05-14T09:00:00Z')
    makeSnapshot('2026-05-15T09-00-00Z', '2026-05-15T09:00:00Z')

    prune(dir, 1)

    const remaining = readdirSync(dir).sort()
    expect(remaining).toContain('README')
    expect(remaining).toContain('2026-05-15T09-00-00Z.sql.gz')
    expect(remaining).toContain('2026-05-15T09-00-00Z-photos.tar.gz')
    expect(remaining).not.toContain('2026-05-13T09-00-00Z.sql.gz')
  })
})
