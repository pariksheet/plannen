import { supabase } from '../lib/supabase'

export interface PhotoPickerSession {
  id: string
  pickerUri: string
  expireTime?: string
}

interface PollPending {
  status: 'pending'
}

interface PollComplete {
  status: 'complete'
  attached: { external_id: string; memory_id: string; filename?: string }[]
  skipped: { external_id: string; reason: string }[]
  total_selected: number
}

export type PhotoPickerPollResult = PollPending | PollComplete

const getFunctionsUrl = () => {
  const url = import.meta.env.VITE_SUPABASE_URL
  if (!url) throw new Error('VITE_SUPABASE_URL is not set')
  return url
}

async function authedFetch(path: string, body: unknown): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  const base = getFunctionsUrl()
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })
}

export async function createPhotoPickerSession(): Promise<PhotoPickerSession> {
  const res = await authedFetch('/functions/v1/picker-session-create', {})
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Failed to create picker session: ${res.status}`)
  }
  return (await res.json()) as PhotoPickerSession
}

export async function pollPhotoPickerSession(
  sessionId: string,
  eventId: string,
): Promise<PhotoPickerPollResult> {
  const res = await authedFetch('/functions/v1/picker-session-poll', { sessionId, eventId })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Failed to poll picker session: ${res.status}`)
  }
  return (await res.json()) as PhotoPickerPollResult
}
