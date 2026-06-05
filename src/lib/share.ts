export interface SharePayload {
  title?: string
  text?: string
  url?: string
}

export function nativeShareSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/**
 * Try the native share-sheet. Returns true if the share completed (or the user
 * cancelled it), false if the platform doesn't support Web Share or the call
 * failed for any other reason — caller should then fall back to a copy link or
 * existing wa.me/email path.
 */
export async function shareNative(payload: SharePayload): Promise<boolean> {
  if (!nativeShareSupported()) return false
  try {
    await navigator.share(payload)
    return true
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return true
    return false
  }
}
