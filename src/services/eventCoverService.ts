import { dbClient } from '../lib/dbClient'
import { compressImage } from '../utils/imageCompression'

const MAX_SIZE_BYTES = 500 * 1024 // 500KB

/**
 * Compress image to max 500KB and upload as event cover.
 * Path: covers/{userId}/{timestamp}.jpg
 * Returns public URL for use as event image_url.
 */
export async function uploadEventCover(file: File): Promise<{ data: string | null; error: Error | null }> {
  try {
    const me = await dbClient.me.get()
    const blob = await compressImage(file, MAX_SIZE_BYTES)
    const filename = `covers/${Date.now()}.jpg`
    // dbClient.memories.uploadFile lays files at <userId>/<filename> — pass a
    // path that includes the covers/ prefix so it lands at
    // event-photos/<userId>/covers/<ts>.jpg.
    const { publicUrl } = await dbClient.memories.uploadFile({
      userId: me.userId,
      filename,
      blob,
      contentType: 'image/jpeg',
    })
    return { data: publicUrl, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Upload failed') }
  }
}
