/**
 * Return the public app URL for share/invite flows. Prefers an explicit
 * VITE_APP_URL override, otherwise derives from the current browser origin.
 * Returns null when running on localhost so we never put dev URLs into
 * outgoing WhatsApp/email messages.
 */
export function getPublicAppUrl(): string | null {
  const fromEnv = (import.meta.env.VITE_APP_URL as string | undefined)?.trim()
  const candidate = fromEnv || (typeof window !== 'undefined' ? window.location.origin : '')
  if (!candidate) return null
  try {
    const u = new URL(candidate)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null
    return candidate.replace(/\/+$/, '')
  } catch {
    return null
  }
}
