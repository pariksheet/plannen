//
// Boot-time singleton selector. Reads PLANNEN_STORAGE_BACKEND once and
// caches the result; tests can call _resetStorageForTests() between runs.
//
// The real adapter branches land in later tasks — this file ships with
// the surface only so the import path is stable.

import type { StorageAdapter } from './adapter.js'
import { createLocalFsAdapter } from './localFs.js'
import { createSupabaseAdapter } from './supabase.js'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

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
    case 'local-fs': {
      const photosRoot = resolve(process.env.PLANNEN_PHOTOS_ROOT ?? join(homedir(), '.plannen', 'photos'))
      const originBaseUrl = process.env.PLANNEN_BACKEND_ORIGIN
        ?? `http://127.0.0.1:${process.env.PLANNEN_BACKEND_PORT ?? 54323}`
      cached = createLocalFsAdapter({ photosRoot, originBaseUrl })
      return cached
    }
    case 'supabase': {
      const supabaseUrl = process.env.SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
          'storage(supabase): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
        )
      }
      cached = createSupabaseAdapter({ supabaseUrl, serviceRoleKey })
      return cached
    }
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
