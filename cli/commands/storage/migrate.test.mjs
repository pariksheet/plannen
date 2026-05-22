import { describe, it, expect, vi } from 'vitest';
import { migrateKeys } from './migrate.mjs';

function adapterStub(initial = new Map()) {
  const store = new Map(initial);
  return {
    store,
    upload: vi.fn(async (key, bytes, _opts) => { store.set(key, bytes); }),
    head: vi.fn(async (key) => store.has(key) ? { size: store.get(key).length, contentType: 'application/octet-stream' } : null),
    delete: vi.fn(async (key) => { const had = store.has(key); store.delete(key); return had; }),
    signedUrl: vi.fn(async (key) => `mock://${key}`),
  };
}

describe('migrateKeys', () => {
  it('copies missing keys and skips existing ones', async () => {
    const source = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],
      ['u/e/b.jpg', new Uint8Array([2])],
    ]));
    const target = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],   // already present
    ]));
    const out = await migrateKeys({
      keys: ['u/e/a.jpg', 'u/e/b.jpg'],
      source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out).toEqual({ copied: 1, skipped: 1, failed: 0 });
    expect(target.store.has('u/e/b.jpg')).toBe(true);
  });

  it('skips keys whose target size matches the source', async () => {
    const source = adapterStub(new Map([['u/e/a.jpg', new Uint8Array([1, 2, 3])]]));
    const target = adapterStub(new Map([['u/e/a.jpg', new Uint8Array([1, 2, 3])]]));
    const out = await migrateKeys({
      keys: ['u/e/a.jpg'], source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out).toEqual({ copied: 0, skipped: 1, failed: 0 });
  });

  it('records failures without aborting the run', async () => {
    const source = adapterStub(new Map([
      ['u/e/a.jpg', new Uint8Array([1])],
      ['u/e/b.jpg', new Uint8Array([2])],
    ]));
    const target = adapterStub();
    target.upload.mockImplementationOnce(async () => { throw new Error('boom'); });
    const out = await migrateKeys({
      keys: ['u/e/a.jpg', 'u/e/b.jpg'], source, target,
      downloadFn: async (key) => source.store.get(key),
    });
    expect(out.copied).toBe(1);
    expect(out.failed).toBe(1);
  });
});
