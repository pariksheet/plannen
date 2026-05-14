import { dbClient } from '../lib/dbClient'

const isLocal = () => {
  const url = import.meta.env.VITE_SUPABASE_URL ?? ''
  const mode = import.meta.env.VITE_PLANNEN_BACKEND_MODE ?? 'supabase'
  return mode === 'plannen-api' || url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
}

export async function hasAppAccess(): Promise<{ allowed: boolean; error: Error | null }> {
  // Single-user / local dev: everyone is allowed — there is no invite gate.
  if (isLocal()) return { allowed: true, error: null }
  // Hosted deployment with multi-user gating is not exposed via the v0 REST
  // surface; allow by default to avoid blocking the UI. The original Tier 1
  // app_allowed_emails lookup remains accessible only via direct DB access.
  try {
    await dbClient.me.get()
    return { allowed: true, error: null }
  } catch (e) {
    return { allowed: false, error: e instanceof Error ? e : null }
  }
}

export async function inviteEmailToApp(email: string): Promise<{ error: Error | null }> {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return { error: new Error('Email is required') }
  // No REST endpoint for app_allowed_emails yet; treat as a no-op in Tier 0.
  return { error: null }
}

/** Sends the "you're invited" email to the given address via the send-invite-email edge function. */
export async function sendInviteEmail(email: string): Promise<{ error: Error | null }> {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return { error: new Error('Email is required') }
  try {
    const data = await dbClient.functions.invoke<{ error?: string | { details?: string } }>(
      'send-invite-email',
      { email: trimmed },
    )
    if (data?.error) {
      const msg = typeof data.error === 'string' ? data.error : data.error.details ?? 'Failed to send email'
      return { error: new Error(msg) }
    }
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Failed to send email') }
  }
}
