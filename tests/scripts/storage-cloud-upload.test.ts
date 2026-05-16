import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import {
  formatBytes,
  quotaCheck,
  readCheckpoint,
  recordCheckpoint,
  storageObjectUrl,
  headCloud,
  downloadFromSource,
  uploadToCloud,
  withRetry,
  run,
} from '../../scripts/lib/storage-cloud-upload.mjs'

describe('formatBytes', () => {
  it('formats bytes / KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })
})

describe('quotaCheck', () => {
  const GB = 1024 * 1024 * 1024
  it('does not warn under the threshold', () => {
    const q = quotaCheck(500 * 1024 * 1024)
    expect(q).toEqual({ warn: false, blocked: false, message: '' })
  })

  it('blocks above threshold without acceptStorageQuota', () => {
    const q = quotaCheck(2 * GB)
    expect(q.warn).toBe(true)
    expect(q.blocked).toBe(true)
    expect(q.message).toMatch(/exceeds free-tier/)
  })

  it('warns but does not block when acceptStorageQuota is true', () => {
    const q = quotaCheck(2 * GB, { acceptStorageQuota: true })
    expect(q.warn).toBe(true)
    expect(q.blocked).toBe(false)
    expect(q.message).toMatch(/proceeding/)
  })

  it('honours custom thresholds', () => {
    const q = quotaCheck(101, { maxBytesBeforeWarn: 100 })
    expect(q.blocked).toBe(true)
  })
})

describe('checkpoint roundtrip', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-cp-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns an empty set when the file does not exist', () => {
    expect(readCheckpoint(join(root, 'missing.txt'))).toEqual(new Set())
  })

  it('records and reads back lines', () => {
    const p = join(root, 'cp.txt')
    recordCheckpoint(p, 'event-photos/a/b/c.jpg')
    recordCheckpoint(p, 'event-photos/x/y/z.heic')
    const set = readCheckpoint(p)
    expect(set.size).toBe(2)
    expect(set.has('event-photos/a/b/c.jpg')).toBe(true)
    expect(set.has('event-photos/x/y/z.heic')).toBe(true)
  })

  it('does not duplicate when the same key is recorded twice in source data', () => {
    const p = join(root, 'cp.txt')
    writeFileSync(p, 'a\na\nb\n')
    const set = readCheckpoint(p)
    expect(set.size).toBe(2)
  })
})

describe('storageObjectUrl', () => {
  it('joins base + path with no double slash', () => {
    expect(storageObjectUrl('http://x.test', 'event-photos', 'a/b/c.jpg')).toBe(
      'http://x.test/storage/v1/object/event-photos/a/b/c.jpg',
    )
    expect(storageObjectUrl('http://x.test/', 'event-photos', 'a/b.jpg')).toBe(
      'http://x.test/storage/v1/object/event-photos/a/b.jpg',
    )
  })
})

describe('HTTP helpers', () => {
  it('headCloud → true on 200, false on 404', async () => {
    const fetch200 = async () => ({ status: 200 }) as Response
    const fetch404 = async () => ({ status: 404 }) as Response
    expect(await headCloud('u', 'k', { fetch: fetch200 as any })).toBe(true)
    expect(await headCloud('u', 'k', { fetch: fetch404 as any })).toBe(false)
  })

  it('downloadFromSource returns Buffer on OK', async () => {
    const fakeFetch = async () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
      }) as unknown as Response
    const buf = await downloadFromSource('u', 'k', { fetch: fakeFetch as any })
    expect(buf.toString('utf8')).toBe('hello')
  })

  it('downloadFromSource throws on non-OK', async () => {
    const fakeFetch = async () => ({ ok: false, status: 500 }) as Response
    await expect(downloadFromSource('u', 'k', { fetch: fakeFetch as any })).rejects.toThrow(/HTTP 500/)
  })

  it('uploadToCloud throws on non-OK', async () => {
    const fakeFetch = async () =>
      ({
        ok: false,
        status: 413,
        text: async () => 'too big',
      }) as unknown as Response
    await expect(
      uploadToCloud('u', 'k', Buffer.from(''), 'image/jpeg', { fetch: fakeFetch as any }),
    ).rejects.toThrow(/HTTP 413.*too big/)
  })
})

describe('withRetry', () => {
  it('returns on first success', async () => {
    let calls = 0
    const out = await withRetry(async () => {
      calls++
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries up to N times then throws the last error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error(`attempt ${calls}`)
        },
        { tries: 3, delay: async () => {} },
      ),
    ).rejects.toThrow(/attempt 3/)
    expect(calls).toBe(3)
  })

  it('succeeds on later attempt', async () => {
    let calls = 0
    const out = await withRetry(
      async () => {
        calls++
        if (calls < 2) throw new Error('not yet')
        return 'finally'
      },
      { tries: 3, delay: async () => {} },
    )
    expect(out).toBe('finally')
    expect(calls).toBe(2)
  })
})

// --- run() integration with a fake fetch + fake pg.Client -------------------

function FakeClient(rows: any[]) {
  return class {
    connected = false
    async connect() {
      this.connected = true
    }
    async query(sql: string, params: any[]) {
      void sql
      void params
      return { rows }
    }
    async end() {}
  }
}

describe('run', () => {
  let root: string
  let cpPath: string
  const ctxBase = (overrides: any = {}) => ({
    tier1DatabaseUrl: 'postgres://t1',
    tier1StorageUrl: 'http://127.0.0.1:54321',
    tier1ServiceRoleKey: 't1srk',
    cloudSupabaseUrl: 'https://abc.supabase.co',
    cloudServiceRoleKey: 'cloud-srk',
    checkpointPath: cpPath,
    ...overrides,
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-up-'))
    cpPath = join(root, 'cp.txt')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('skipPhotos short-circuits', async () => {
    const ctx = await run({ ...ctxBase(), skipPhotos: true })
    expect(ctx.uploadedCount).toBe(0)
    expect(ctx.totalSourceCount).toBe(0)
  })

  it('uploads each row, skipping ones that HEAD-200 on cloud', async () => {
    const rows = [
      { name: 'e1/u1/a.jpg', size: 100, mimetype: 'image/jpeg', owner: 'u1' },
      { name: 'e1/u1/b.jpg', size: 200, mimetype: 'image/jpeg', owner: 'u1' },
    ]
    const ops: string[] = []
    const fakeFetch = async (url: string, init: any) => {
      const method = init?.method ?? 'GET'
      const tag = `${method} ${url}`
      ops.push(tag)
      if (method === 'HEAD' && url.includes('a.jpg')) {
        return { status: 200 } as Response
      }
      if (method === 'HEAD') return { status: 404 } as Response
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(4),
        } as unknown as Response
      }
      // POST
      return { ok: true, status: 200 } as Response
    }

    const out = await run(ctxBase(), {
      fetch: fakeFetch as any,
      Client: FakeClient(rows),
      delay: async () => {},
      log: () => {},
    })

    expect(out.uploadedCount).toBe(1) // b.jpg
    expect(out.skippedCount).toBe(1) // a.jpg (already on cloud)
    expect(out.totalSourceCount).toBe(2)
    expect(out.totalSourceBytes).toBe(300)

    // Checkpoint contains both keys.
    const cp = readFileSync(cpPath, 'utf8')
    expect(cp).toContain('event-photos/e1/u1/a.jpg')
    expect(cp).toContain('event-photos/e1/u1/b.jpg')

    // Verify call order for b.jpg: HEAD → GET (source) → POST (cloud).
    const bOps = ops.filter((o) => o.includes('b.jpg'))
    expect(bOps[0]).toMatch(/^HEAD https:\/\/abc/)
    expect(bOps[1]).toMatch(/^GET http:\/\/127/)
    expect(bOps[2]).toMatch(/^POST https:\/\/abc/)
  })

  it('respects an existing checkpoint and never HEADs those rows', async () => {
    writeFileSync(cpPath, 'event-photos/e1/u1/a.jpg\n')
    const rows = [{ name: 'e1/u1/a.jpg', size: 100, mimetype: 'image/jpeg', owner: 'u1' }]
    const ops: string[] = []
    const fakeFetch = async (url: string, init: any) => {
      ops.push(`${init?.method ?? 'GET'} ${url}`)
      throw new Error('should not be called')
    }

    const out = await run(ctxBase(), {
      fetch: fakeFetch as any,
      Client: FakeClient(rows),
      log: () => {},
    })

    expect(out.skippedCount).toBe(1)
    expect(out.uploadedCount).toBe(0)
    expect(ops.length).toBe(0)
  })

  it('blocks when total exceeds 1 GB and acceptStorageQuota is unset', async () => {
    const rows = [
      { name: 'big.jpg', size: 2 * 1024 * 1024 * 1024, mimetype: 'image/jpeg', owner: 'u1' },
    ]
    await expect(
      run(ctxBase(), {
        fetch: (async () => ({ status: 200 })) as any,
        Client: FakeClient(rows),
        log: () => {},
      }),
    ).rejects.toThrow(/exceeds free-tier/)
  })

  it('proceeds when acceptStorageQuota=true even past 1 GB', async () => {
    const rows = [
      { name: 'big.jpg', size: 2 * 1024 * 1024 * 1024, mimetype: 'image/jpeg', owner: 'u1' },
    ]
    const fakeFetch = async (_url: string, init: any) => {
      if (init?.method === 'HEAD') return { status: 404 } as Response
      if (init?.method === 'POST') return { ok: true, status: 200 } as Response
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as unknown as Response
    }
    const out = await run(
      { ...ctxBase(), acceptStorageQuota: true },
      {
        fetch: fakeFetch as any,
        Client: FakeClient(rows),
        delay: async () => {},
        log: () => {},
      },
    )
    expect(out.uploadedCount).toBe(1)
  })

  it('requires all five connection fields', async () => {
    const partial = { tier1DatabaseUrl: 'x' }
    await expect(run(partial, { Client: FakeClient([]) })).rejects.toThrow(
      /tier1StorageUrl/,
    )
  })

  it('retries upload failures up to 3 times', async () => {
    const rows = [{ name: 'flaky.jpg', size: 1, mimetype: 'image/jpeg', owner: 'u' }]
    let postCalls = 0
    const fakeFetch = async (url: string, init: any) => {
      if (init?.method === 'HEAD') return { status: 404 } as Response
      if (init?.method === 'POST') {
        postCalls++
        if (postCalls < 3) {
          return { ok: false, status: 502, text: async () => 'gateway' } as unknown as Response
        }
        return { ok: true, status: 200 } as Response
      }
      // GET (default for downloadFromSource which sets no method)
      void url
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(1),
      } as unknown as Response
    }

    const out = await run(ctxBase(), {
      fetch: fakeFetch as any,
      Client: FakeClient(rows),
      delay: async () => {},
      log: () => {},
    })
    expect(out.uploadedCount).toBe(1)
    expect(postCalls).toBe(3)
  })
})

// Silence unused-import lint warning when import paths fail to resolve in CI;
// the actual import above is verified by every test below.
void existsSync
