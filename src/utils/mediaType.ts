export type MediaType = 'image' | 'video' | 'audio'

/**
 * Map a MIME type (e.g. from File.type) to the Plannen media kind.
 * Falls back to 'image' for unknown / empty MIMEs because the existing
 * upload paths historically only handled images and the fallback keeps
 * pre-multimedia rows behaving the same.
 */
export function mediaTypeFromMime(mime: string): MediaType {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'image'
}
