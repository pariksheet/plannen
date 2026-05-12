import { supabase } from '../lib/supabase'
import { compressImage } from '../utils/imageCompression'

const BUCKET = 'event-photos'
const COVERS_PREFIX = 'covers'
const MAX_SIZE_BYTES = 500 * 1024 // 500KB

/**
 * Compress image to max 500KB and upload as event cover.
 * Path: covers/{userId}/{timestamp}.jpg
 * Returns public URL for use as event image_url.
 */
export async function uploadEventCover(file: File): Promise<{ data: string | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }

  const blob = await compressImage(file, MAX_SIZE_BYTES)
  const path = `${COVERS_PREFIX}/${user.id}/${Date.now()}.jpg`
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (uploadError) return { data: null, error: new Error(uploadError.message) }

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { data: publicUrl, error: null }
}
