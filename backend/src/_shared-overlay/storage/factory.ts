//
// Boot-time singleton selector. Reads PLANNEN_STORAGE_BACKEND once and
// caches the result; tests can call _resetStorageForTests() between runs.
//
// The real adapter branches land in later tasks — this file ships with
// the surface only so the import path is stable.

import type { StorageAdapter } from './adapter.js'

let cached: StorageAdapter | null = null

export function getStorage(): StorageAdapter {
  if (cached) return cached
  const choice = process.env.PLANNEN_STORAGE_BACKEND
  if (!choice) {
    throw new Error(
      'storage: PLANNEN_STORAGE_BACKEND is not set. ' +
        'Expected one of: local-fs, supabase, s3.',
    )
  }
  switch (choice) {
    case 'local-fs':
    case 'supabase':
    case 's3':
      throw new Error(`storage: backend "${choice}" not yet wired (factory stub)`)
    default:
      throw new Error(`storage: unknown storage backend "${choice}"`)
  }
}

/** Test-only escape hatch — must NOT be called from production code paths. */
export function _resetStorageForTests(): void {
  cached = null
}
