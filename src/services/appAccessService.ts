import { supabase } from '../lib/supabase'

const isLocal = () => {
  const url = import.meta.env.VITE_SUPABASE_URL ?? ''
  return url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
}

export async function hasAppAccess(): Promise<{ allowed: boolean; error: Error | null }> {
  // In local dev (Tier 1) all authenticated users are allowed — no invite gate.
  if (isLocal()) return { allowed: true, error: null }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError) return { allowed: false, error: new Error(authError.message) }
  if (!user || !user.email) return { allowed: false, error: null }

  const email = user.email.toLowerCase()

  const { data, error } = await supabase
    .from('app_allowed_emails')
    .select('email')
    .eq('email', email)
    .maybeSingle()

  if (error) return { allowed: false, error: new Error(error.message) }

  return { allowed: !!data, error: null }
}

export async function inviteEmailToApp(email: string): Promise<{ error: Error | null }> {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return { error: new Error('Email is required') }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError) return { error: new Error(authError.message) }
  if (!user) return { error: new Error('Not authenticated') }

  const { error } = await supabase.from('app_allowed_emails').upsert({
    email: trimmed,
    invited_by: user.id,
  })

  return { error: error ? new Error(error.message) : null }
}

/** Sends the "you're invited" email to the given address via Mailgun (Supabase Edge Function). */
export async function sendInviteEmail(email: string): Promise<{ error: Error | null }> {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return { error: new Error('Email is required') }

  const { data, error } = await supabase.functions.invoke('send-invite-email', {
    body: { email: trimmed },
  })

  if (error) return { error: new Error(error.message) }
  if (data?.error) return { error: new Error(typeof data.error === 'string' ? data.error : (data.error as { details?: string }).details ?? 'Failed to send email') }
  return { error: null }
}
