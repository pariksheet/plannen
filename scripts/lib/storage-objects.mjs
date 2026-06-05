// Pure synthesis of Supabase storage.objects rows + on-disk layout.
//
//   synthesize(files, { uuid })
//
// Given a list of files (already inventoried — path inside bucket, size,
// mimetype, owner, content etag, last-modified timestamp, source path on
// disk), returns:
//   { rows:   [ <storage.objects row> ],
//     layout: [ { srcAbsPath, destRelPath } ] }
//
// Tier 1's Supabase storage container expects files under
//   /mnt/<TENANT_ID>/<GLOBAL_S3_BUCKET>/<bucket>/<path>/<version-uuid>
// With TENANT_ID=stub and GLOBAL_S3_BUCKET=stub (the local-dev defaults),
// the layout returned here is relative to /mnt — i.e. it starts at
//   stub/stub/<bucket>/<path>/<version-uuid>
//
// Schema columns verified against Supabase storage v1.54 (postgres 17):
//   id, bucket_id, name, owner, owner_id, created_at, updated_at,
//   last_accessed_at, metadata (jsonb), version, user_metadata (jsonb)
//   path_tokens is generated; do not insert.

import { randomUUID } from 'node:crypto'

const TENANT_ID = 'stub'
const GLOBAL_S3_BUCKET = 'stub'

export function synthesize(files, opts = {}) {
  const uuid = opts.uuid ?? randomUUID

  const rows = []
  const layout = []

  for (const f of files) {
    const version = uuid()
    const id = uuid()

    rows.push({
      id,
      bucket_id: f.bucket,
      name: f.path,
      owner: f.owner ?? null,
      owner_id: f.owner ?? null,
      created_at: f.lastModified,
      updated_at: f.lastModified,
      last_accessed_at: f.lastModified,
      metadata: {
        eTag: `"${f.etag}"`,
        size: f.size,
        mimetype: f.mimetype,
        cacheControl: 'max-age=3600',
        lastModified: f.lastModified,
        contentLength: f.size,
        httpStatusCode: 200,
      },
      version,
      user_metadata: {},
    })

    layout.push({
      srcAbsPath: f.srcAbsPath,
      destRelPath: `${TENANT_ID}/${GLOBAL_S3_BUCKET}/${f.bucket}/${f.path}/${version}`,
    })
  }

  return { rows, layout }
}
