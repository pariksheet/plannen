// supabase/functions/_shared/storage/factory.ts
//
// Deno-side factory. Edge functions only ever run in deployments where
// PLANNEN_STORAGE_BACKEND=supabase — local-fs requires Node fs and s3
// requires the Node backend's signed-URL endpoints. Both throw with a
// clear pointer to the Node backend if mistakenly set.

import type { StorageAdapter } from './adapter.ts'
import { createSupabaseAdapter } from './supabase.ts'

let cached: StorageAdapter | null = null

export function getStorage(): StorageAdapter {
  if (cached) return cached
  const choice = Deno.env.get('PLANNEN_STORAGE_BACKEND')
  if (!choice) {
    throw new Error(
      'storage: PLANNEN_STORAGE_BACKEND is not set. ' +
        'Edge functions only support `supabase` (set it explicitly to that value).',
    )
  }
  if (choice === 'local-fs' || choice === 's3') {
    throw new Error(
      `storage(edge): backend "${choice}" not supported in Deno edge runtime — ` +
      `the Node backend (backend/src) handles local-fs and s3. ` +
      `Route this call to the Node backend, or set PLANNEN_STORAGE_BACKEND=supabase.`,
    )
  }
  if (choice !== 'supabase') {
    throw new Error(`storage: unknown storage backend "${choice}"`)
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'storage(supabase): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
    )
  }
  cached = createSupabaseAdapter({ supabaseUrl, serviceRoleKey })
  return cached
}

/** Test-only escape hatch — must NOT be called from production code paths. */
export function _resetStorageForTests(): void {
  cached = null
}
