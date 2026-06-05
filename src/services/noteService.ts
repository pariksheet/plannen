import { dbClient } from '../lib/dbClient'

export interface EventNote {
  id: string
  event_id: string
  user_id: string
  body: string
  created_at: string
  updated_at: string
  author?: { full_name?: string | null; email?: string | null } | null
}

export async function listEventNotes(eventId: string): Promise<{ data: EventNote[]; error: Error | null }> {
  try {
    const data = await dbClient.notes.list({ event_id: eventId })
    return { data: data as unknown as EventNote[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List notes failed') }
  }
}

export async function createNote(eventId: string, body: string): Promise<{ data: EventNote | null; error: Error | null }> {
  const trimmed = body.trim()
  if (!trimmed) return { data: null, error: new Error('Note body is required') }
  try {
    const row = await dbClient.notes.create({ event_id: eventId, body: trimmed })
    return { data: row as unknown as EventNote, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create note failed') }
  }
}

export async function updateNote(id: string, body: string): Promise<{ data: EventNote | null; error: Error | null }> {
  const trimmed = body.trim()
  if (!trimmed) return { data: null, error: new Error('Note body is required') }
  try {
    const row = await dbClient.notes.update(id, { body: trimmed })
    return { data: row as unknown as EventNote, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Update note failed') }
  }
}

export async function deleteNote(id: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.notes.delete(id)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete note failed') }
  }
}
