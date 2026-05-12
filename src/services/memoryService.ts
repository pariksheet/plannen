import { supabase } from '../lib/supabase'
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
  const { data, error } = await supabase
    .from('event_memories')
    .select('id, event_id, user_id, media_url, media_type, caption, created_at, taken_at, source, external_id, transcript, transcript_lang, transcribed_at, user:users(full_name, email)')
    .eq('event_id', eventId)
    .order('taken_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (error) return { data: [], error: new Error(error.message) }
  const rows = (data ?? []) as (Omit<EventMemory, 'user'> & { user?: { full_name?: string; email?: string } })[]
  return { data: rows as EventMemory[], error: null }
}

export async function uploadMemory(
  eventId: string,
  file: File,
  caption?: string
): Promise<{ data: EventMemory | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }

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
  const path = `${eventId}/${user.id}/${Date.now()}.${ext}`
  const { error: uploadError } = await supabase.storage.from('event-photos').upload(path, fileToUpload, { upsert: false })
  if (uploadError) return { data: null, error: new Error(uploadError.message) }

  const { data: { publicUrl } } = supabase.storage.from('event-photos').getPublicUrl(path)
  const { data: row, error: insertError } = await supabase
    .from('event_memories')
    .insert({
      event_id: eventId,
      user_id: user.id,
      media_url: publicUrl,
      media_type: detectedType,
      caption: caption || null,
      source: 'upload',
    })
    .select()
    .single()
  if (insertError) return { data: null, error: new Error(insertError.message) }
  return { data: row as EventMemory, error: null }
}

export async function addMemoryFromGoogle(
  eventId: string,
  source: 'google_drive' | 'google_photos',
  externalId: string,
  caption?: string,
  mimeType?: string
): Promise<{ data: EventMemory | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const detectedType: MediaType = mimeType ? mediaTypeFromMime(mimeType) : 'image'
  const { data: row, error: insertError } = await supabase
    .from('event_memories')
    .insert({
      event_id: eventId,
      user_id: user.id,
      media_url: null,
      media_type: detectedType,
      caption: caption || null,
      source,
      external_id: externalId,
    })
    .select()
    .single()
  if (insertError) return { data: null, error: new Error(insertError.message) }
  return { data: row as EventMemory, error: null }
}

/** URL for the memory image proxy (use with fetch + Authorization header for external sources). */
export function getMemoryImageProxyUrl(memoryId: string, supabaseUrl: string): string {
  return `${supabaseUrl}/functions/v1/memory-image?memory_id=${encodeURIComponent(memoryId)}`
}

const SOFT_CAP_BYTES = 200 * 1024 * 1024

export function shouldWarnLargeFile(file: File): string | null {
  if (file.size <= SOFT_CAP_BYTES) return null
  const mb = Math.round(file.size / 1024 / 1024)
  return `${file.name} is ${mb} MB. It will add to backups and make export-seed.sh slower. Upload anyway?`
}

export async function deleteMemory(memoryId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase.from('event_memories').delete().eq('id', memoryId)
  return { error: error ? new Error(error.message) : null }
}
