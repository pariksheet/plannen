import { supabase } from '../lib/supabase'

const getFunctionsUrl = () => {
  const url = import.meta.env.VITE_SUPABASE_URL
  if (!url) throw new Error('VITE_SUPABASE_URL is not set')
  return url
}

export async function getGoogleAuthUrl(): Promise<{ url: string; state: string }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  const base = getFunctionsUrl()
  const res = await fetch(`${base}/functions/v1/get-google-auth-url`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Failed to get auth URL: ${res.status}`)
  }
  const body = (await res.json()) as { url: string; state: string }
  return body
}

export async function getGoogleAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  const base = getFunctionsUrl()
  const res = await fetch(`${base}/functions/v1/get-google-access-token`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (res.status === 404) throw new Error('Google not connected')
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Failed to get token: ${res.status}`)
  }
  const body = (await res.json()) as { access_token: string }
  return body.access_token
}
