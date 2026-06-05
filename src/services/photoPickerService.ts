import { dbClient } from '../lib/dbClient'

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

export async function createPhotoPickerSession(): Promise<PhotoPickerSession> {
  return await dbClient.functions.invoke<PhotoPickerSession>('picker-session-create', {})
}

export async function pollPhotoPickerSession(
  sessionId: string,
  eventId: string,
): Promise<PhotoPickerPollResult> {
  return await dbClient.functions.invoke<PhotoPickerPollResult>('picker-session-poll', { sessionId, eventId })
}
