import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore — .mjs module
import {
  storageObjectUrl,
  stagePathFor,
  run,
} from '../../scripts/lib/dump-cloud-photos.mjs'

describe('storageObjectUrl', () => {
  it('builds the Storage REST URL with per-segment encoding', () => {
    expect(storageObjectUrl('https://x.supabase.co', 'event-photos', 'a/b/c.jpg')).toBe(
      'https://x.supabase.co/storage/v1/object/event-photos/a/b/c.jpg',
    )
  })

  it('encodes special characters within a segment but preserves /', () => {
    expect(storageObjectUrl('https://x.supabase.co', 'event-photos', 'a b/c d.jpg')).toBe(
      'https://x.supabase.co/storage/v1/object/event-photos/a%20b/c%20d.jpg',
    )
  })

  it('strips trailing slash from base URL', () => {
    expect(storageObjectUrl('https://x.supabase.co/', 'event-photos', 'a.jpg')).toBe(
      'https://x.supabase.co/storage/v1/object/event-photos/a.jpg',
    )
  })
})

describe('stagePathFor', () => {
  it('returns flat bucket/name layout (no version-uuid dir)', () => {
    expect(stagePathFor('event-photos', 'evt1/user1/photo.jpg')).toBe(
      'event-photos/evt1/user1/photo.jpg',
    )
  })
})

describe('run', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-dcp-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists, downloads, and stages files into the bucket dir', async () => {
    const ClientCtor = class {
      constructor() {}
      async connect() {}
      async query() {
        return { rows: [{ name: 'evt1/u/a.jpg' }, { name: 'evt2/u/b.heic' }] }
      }
      async end() {}
    }
    const fetchImpl = async (url: string) => {
      const last = url.split('/').pop() ?? ''
      const body = `body-of-${last}`
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Buffer.from(body),
      }
    }
    const stage = mkdtempSync(join(tmpdir(), 'plannen-dcp-stage-'))
    const tarCalls: string[] = []
    const result = await run(
      {
        databaseUrl: 'postgres://ignored',
        supabaseUrl: 'https://x.supabase.co',
        serviceRoleKey: 'svc',
        outPath: join(root, 'out.tar.gz'),
      },
      {
        ClientCtor,
        fetch: fetchImpl,
        mkStage: () => stage,
        keepStage: true,
        tar: (cmd: string) => { tarCalls.push(cmd) },
        log: () => {},
      },
    )

    expect(result.count).toBe(2)
    expect(result.failed).toBe(0)
    expect(existsSync(join(stage, 'event-photos/evt1/u/a.jpg'))).toBe(true)
    expect(existsSync(join(stage, 'event-photos/evt2/u/b.heic'))).toBe(true)
    expect(statSync(join(stage, 'event-photos/evt1/u/a.jpg')).size).toBeGreaterThan(0)
    expect(tarCalls).toHaveLength(1)
    expect(tarCalls[0]).toContain(`tar czf "${join(root, 'out.tar.gz')}"`)
    expect(tarCalls[0]).toContain(`-C "${stage}"`)
    rmSync(stage, { recursive: true, force: true })
  })

  it('skips tarball when bucket is empty', async () => {
    const ClientCtor = class {
      async connect() {}
      async query() { return { rows: [] } }
      async end() {}
    }
    const result = await run(
      {
        databaseUrl: 'postgres://ignored',
        supabaseUrl: 'https://x.supabase.co',
        serviceRoleKey: 'svc',
        outPath: join(root, 'out.tar.gz'),
      },
      { ClientCtor, log: () => {} },
    )
    expect(result.count).toBe(0)
    expect(result.tarPath).toBeNull()
  })

  it('counts failed downloads but keeps going', async () => {
    const ClientCtor = class {
      async connect() {}
      async query() {
        return { rows: [{ name: 'ok.jpg' }, { name: 'bad.jpg' }] }
      }
      async end() {}
    }
    const fetchImpl = async (url: string) => {
      if (url.includes('bad.jpg')) return { ok: false, status: 404, statusText: 'Not Found' }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Buffer.from('ok'),
      }
    }
    const stage = mkdtempSync(join(tmpdir(), 'plannen-dcp-stage-'))
    const result = await run(
      {
        databaseUrl: 'postgres://ignored',
        supabaseUrl: 'https://x.supabase.co',
        serviceRoleKey: 'svc',
        outPath: join(root, 'out.tar.gz'),
      },
      {
        ClientCtor,
        fetch: fetchImpl,
        mkStage: () => stage,
        keepStage: true,
        tar: () => {},
        log: () => {},
      },
    )
    expect(result.count).toBe(1)
    expect(result.failed).toBe(1)
    rmSync(stage, { recursive: true, force: true })
  })
})
