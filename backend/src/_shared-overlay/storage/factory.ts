//
// Boot-time singleton selector. Reads PLANNEN_STORAGE_BACKEND once and
// caches the result; tests can call _resetStorageForTests() between runs.
//
// The real adapter branches land in later tasks — this file ships with
// the surface only so the import path is stable.

import type { StorageAdapter } from './adapter.js'
import { createLocalFsAdapter } from './localFs.js'
import { createSupabaseAdapter } from './supabase.js'
import { createS3Adapter, type S3AdapterOptions } from './s3.js'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

let cached: StorageAdapter | null = null

function readS3Env(): S3AdapterOptions {
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'auto'
  const bucket = process.env.S3_BUCKET
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL ?? ''
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'
  const required = {
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  }
  const missingKeys = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
  if (missingKeys.length > 0) {
    throw new Error(`storage(s3): missing env: ${missingKeys.join(', ')}`)
  }
  return {
    endpoint: endpoint!,
    region,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    publicBaseUrl,
    forcePathStyle,
  }
}

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
    case 's3': {
      cached = createS3Adapter(readS3Env())
      return cached
    }
    default:
      throw new Error(`storage: unknown storage backend "${choice}"`)
  }
}

/** Test-only escape hatch — must NOT be called from production code paths. */
export function _resetStorageForTests(): void {
  cached = null
}
