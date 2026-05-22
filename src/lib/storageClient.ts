//
// Frontend façade over /api/photos/*. UI components never construct
// storage URLs directly — they call upload() / downloadUrl() / delete()
// and the backend translates per the configured PLANNEN_STORAGE_BACKEND.

export interface UploadArgs {
  eventId: string
  filename: string
  blob: Blob
}

export interface UploadResult {
  key: string
  /** Initial signed URL, suitable for immediate display while the row is fresh. */
  signedUrl: string
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`storageClient.${label}: ${res.status} ${detail}`)
  }
  return await res.json() as T
}

async function downloadUrl(key: string): Promise<string> {
  const body = await jsonOrThrow<{ url: string }>(
    await fetch(`/api/photos/signed-url?key=${encodeURIComponent(key)}`),
    'signed-url',
  )
  return body.url
}

export const storageClient = {
  async upload({ eventId, filename, blob }: UploadArgs): Promise<UploadResult> {
    const intent = await jsonOrThrow<{
      key: string
      upload_url: string
      method: string
      headers?: Record<string, string>
    }>(
      await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, filename, content_type: blob.type || 'application/octet-stream' }),
      }),
      'upload-url',
    )
    const putRes = await fetch(intent.upload_url, {
      method: intent.method,
      headers: intent.headers ?? { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => '')
      throw new Error(`storageClient.upload: PUT failed ${putRes.status} ${detail}`)
    }
    const signedUrl = await downloadUrl(intent.key)
    return { key: intent.key, signedUrl }
  },

  downloadUrl,

  async delete(key: string): Promise<void> {
    const res = await fetch('/api/photos', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`storageClient.delete: ${res.status} ${detail}`)
    }
  },
}
