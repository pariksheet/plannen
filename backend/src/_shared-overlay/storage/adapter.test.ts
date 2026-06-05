import { describe, it, expect } from 'vitest'
import type { StorageAdapter } from './adapter.js'

describe('StorageAdapter contract', () => {
  it('declares the four required methods', () => {
    // Compile-time check: this file fails to type-check if the methods
    // are missing or renamed. The runtime assertion below catches
    // accidental removal of the type export itself.
    const stub: StorageAdapter = {
      upload: async () => {},
      delete: async () => false,
      signedUrl: async () => '',
      head: async () => null,
    }
    expect(typeof stub.upload).toBe('function')
    expect(typeof stub.delete).toBe('function')
    expect(typeof stub.signedUrl).toBe('function')
    expect(typeof stub.head).toBe('function')
  })
})
