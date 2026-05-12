import { supabase } from '../lib/supabase'
import type { Story, StoryWithEvents, StoryEventLink, StorySibling, StoryWithEventsAndSiblings } from '../types/story'

interface RawStoryRow extends Story {
  story_events?: { events: StoryEventLink | null }[] | null
}

function flattenEvents(row: RawStoryRow): StoryWithEvents {
  const events = (row.story_events ?? [])
    .map(l => l.events)
    .filter((e): e is StoryEventLink => !!e)
  const { story_events: _ignore, ...rest } = row
  return { ...(rest as Story), events }
}

export async function listStories(): Promise<StoryWithEvents[]> {
  const { data, error } = await supabase
    .from('stories')
    .select('*, story_events(events:event_id(id, title, start_date))')
    .order('generated_at', { ascending: false })
  if (error) throw error
  return (data as unknown as RawStoryRow[] | null)?.map(flattenEvents) ?? []
}

export async function getStory(id: string): Promise<StoryWithEventsAndSiblings | null> {
  const { data, error } = await supabase
    .from('stories')
    .select('*, story_events(events:event_id(id, title, start_date))')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const flat = flattenEvents(data as unknown as RawStoryRow)
  // Fetch sibling translations (same group, all languages including self)
  const { data: sibs, error: sibErr } = await supabase
    .from('stories')
    .select('id, language')
    .eq('story_group_id', flat.story_group_id)
    .order('generated_at', { ascending: true })
  if (sibErr) throw sibErr
  return { ...flat, siblings: (sibs ?? []) as StorySibling[] }
}

export async function getEventStory(eventId: string): Promise<StoryWithEvents | null> {
  const { data, error } = await supabase
    .from('story_events')
    .select('stories(*, story_events(events:event_id(id, title, start_date)))')
    .eq('event_id', eventId)
  if (error) throw error
  const rows = (data as unknown as { stories: RawStoryRow | null }[] | null) ?? []
  const candidates = rows
    .map(r => r.stories)
    .filter((s): s is RawStoryRow => !!s)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const aLen = (a.story_events ?? []).length
    const bLen = (b.story_events ?? []).length
    if (aLen !== bLen) return aLen - bLen
    return (b.generated_at ?? '').localeCompare(a.generated_at ?? '')
  })
  return flattenEvents(candidates[0])
}

export async function updateStory(
  id: string,
  patch: Partial<Pick<Story, 'title' | 'body' | 'cover_url'>>,
): Promise<Story> {
  const { data, error } = await supabase
    .from('stories')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data as Story
}

export async function deleteStory(id: string): Promise<void> {
  const { error } = await supabase.from('stories').delete().eq('id', id)
  if (error) throw error
}
