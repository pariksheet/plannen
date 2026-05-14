import { dbClient } from '../lib/dbClient'
import type { MediaType } from '../utils/mediaType'
import { mediaTypeFromMime } from '../utils/mediaType'
import { compressImage } from '../utils/imageCompression'

export type { MediaType } from '../utils/mediaType'
export type MemorySource = 'upload' | 'google_drive' | 'google_photos'

export interface EventMemory {
  id: string
  event_id: string
  user_id: string
  media_url: string | null         // was: photo_url
  media_type: MediaType            // new
  caption: string | null
  taken_at: string | null
  created_at: string
  source: MemorySource | null
  external_id: string | null
  transcript: string | null
  transcript_lang: string | null
  transcribed_at: string | null
  user?: { full_name?: string; email?: string }
}

export async function getEventMemories(eventId: string): Promise<{ data: EventMemory[]; error: Error | null }> {
  try {
    const rows = await dbClient.memories.list({ event_id: eventId })
    return { data: rows as unknown as EventMemory[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List memories failed') }
  }
}

export async function uploadMemory(
  eventId: string,
  file: File,
  caption?: string
): Promise<{ data: EventMemory | null; error: Error | null }> {
  let userId: string
  try {
    const me = await dbClient.me.get()
    userId = me.userId
  } catch {
    return { data: null, error: new Error('Not authenticated') }
  }

  const detectedType = mediaTypeFromMime(file.type)
  let fileToUpload: File | Blob = file
  if (detectedType === 'image') {
    try {
      fileToUpload = await compressImage(file)
    } catch (e) {
      return { data: null, error: e instanceof Error ? e : new Error('Compression failed') }
    }
  }

  const ext = file.name.split('.').pop() || 'jpg'
  const filename = `${eventId}/${Date.now()}.${ext}`
  let publicUrl: string
  try {
    const up = await dbClient.memories.uploadFile({
      userId,
      filename,
      blob: fileToUpload,
      contentType: file.type || 'application/octet-stream',
    })
    publicUrl = up.publicUrl
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Upload failed') }
  }

  try {
    const row = await dbClient.memories.create({
      event_id: eventId,
      media_url: publicUrl,
      media_type: detectedType,
      caption: caption || null,
      source: 'upload',
    })
    return { data: row as unknown as EventMemory, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Insert memory failed') }
  }
}

export async function addMemoryFromGoogle(
  eventId: string,
  source: 'google_drive' | 'google_photos',
  externalId: string,
  caption?: string,
  mimeType?: string
): Promise<{ data: EventMemory | null; error: Error | null }> {
  const detectedType: MediaType = mimeType ? mediaTypeFromMime(mimeType) : 'image'
  try {
    const row = await dbClient.memories.create({
      event_id: eventId,
      media_url: null,
      media_type: detectedType,
      caption: caption || null,
      source,
      external_id: externalId,
    })
    return { data: row as unknown as EventMemory, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Add memory failed') }
  }
}

/** URL for the memory image proxy (use with fetch + Authorization header for external sources). */
export function getMemoryImageProxyUrl(memoryId: string, supabaseUrl: string): string {
  // In Tier 0, the caller passes "" or omits supabaseUrl — fall back to a
  // same-origin path against the local backend.
  const base = supabaseUrl || ''
  return `${base}/functions/v1/memory-image?memory_id=${encodeURIComponent(memoryId)}`
}

const SOFT_CAP_BYTES = 200 * 1024 * 1024

export function shouldWarnLargeFile(file: File): string | null {
  if (file.size <= SOFT_CAP_BYTES) return null
  const mb = Math.round(file.size / 1024 / 1024)
  return `${file.name} is ${mb} MB. It will add to backups and make export-seed.sh slower. Upload anyway?`
}

export async function deleteMemory(memoryId: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.memories.delete(memoryId)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete memory failed') }
  }
}
