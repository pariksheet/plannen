/**
 * Render a friendly label for a user reference whose name/email may be
 * missing. Falls back to a short ID instead of leaking a full UUID into
 * the UI when nothing better is available.
 */
export function displayUserLabel(user: {
  id: string
  full_name?: string | null
  email?: string | null
}): string {
  if (user.full_name?.trim()) return user.full_name.trim()
  if (user.email?.trim()) return user.email.trim()
  return `Member ${user.id.slice(0, 8)}`
}
