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
})
