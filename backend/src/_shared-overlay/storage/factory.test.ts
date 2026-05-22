import { describe, it, expect, afterEach } from 'vitest'
import { getStorage, _resetStorageForTests } from './factory.js'

afterEach(() => {
  _resetStorageForTests()
  delete process.env.PLANNEN_STORAGE_BACKEND
})

describe('getStorage', () => {
  it('throws when PLANNEN_STORAGE_BACKEND is unset', () => {
    expect(() => getStorage()).toThrow(/PLANNEN_STORAGE_BACKEND/)
  })

  it('throws on an unknown backend value', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'gcs'
    expect(() => getStorage()).toThrow(/unknown storage backend.*gcs/i)
  })

  it('returns a local-fs adapter when PLANNEN_STORAGE_BACKEND=local-fs', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'plannen-factory-'))
    process.env.PLANNEN_STORAGE_BACKEND = 'local-fs'
    process.env.PLANNEN_PHOTOS_ROOT = root
    try {
      const a = getStorage()
      await a.upload('u/e/x.jpg', new Uint8Array([1]), { contentType: 'image/jpeg' })
      expect(await a.head('u/e/x.jpg')).toEqual({ size: 1, contentType: 'image/jpeg' })
    } finally {
      rmSync(root, { recursive: true, force: true })
      delete process.env.PLANNEN_PHOTOS_ROOT
    }
  })

  it('returns a supabase adapter when PLANNEN_STORAGE_BACKEND=supabase', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'supabase'
    process.env.SUPABASE_URL = 'https://abc.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    try {
      expect(getStorage()).toBeDefined()
    } finally {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  })

  it('refuses supabase when credentials are missing', () => {
    process.env.PLANNEN_STORAGE_BACKEND = 'supabase'
    expect(() => getStorage()).toThrow(/SUPABASE_URL/)
  })
})
