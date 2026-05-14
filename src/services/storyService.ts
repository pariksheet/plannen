import { dbClient } from '../lib/dbClient'
import type { Story, StoryWithEvents, StoryEventLink, StorySibling, StoryWithEventsAndSiblings } from '../types/story'

interface RawStoryRow extends Story {
  // Tier 1 (supabase-js) returns `story_events: [{ events: { ... } }]`.
  // Tier 0 (REST) returns `events: [{ ... }]` directly. Handle both shapes.
  story_events?: { events: StoryEventLink | null }[] | null
  events?: StoryEventLink[] | null
}

function flattenEvents(row: RawStoryRow): StoryWithEvents {
  let events: StoryEventLink[]
  if (Array.isArray(row.events)) {
    events = row.events.filter((e): e is StoryEventLink => !!e)
  } else {
    events = (row.story_events ?? [])
      .map((l) => l.events)
      .filter((e): e is StoryEventLink => !!e)
  }
  const { story_events: _se, events: _ev, ...rest } = row
  void _se
  void _ev
  return { ...(rest as Story), events }
}

export async function listStories(): Promise<StoryWithEvents[]> {
  const rows = await dbClient.stories.list()
  return (rows as unknown as RawStoryRow[]).map(flattenEvents)
}

export async function getStory(id: string): Promise<StoryWithEventsAndSiblings | null> {
  const row = await dbClient.stories.get(id)
  if (!row) return null
  const flat = flattenEvents(row as unknown as RawStoryRow)
  // Siblings (other translations in the same story_group_id) — fetch by listing
  // all stories and filtering client-side. v0 REST has no /stories?group_id=...
  // endpoint, so we accept the extra payload.
  let siblings: StorySibling[] = []
  if (flat.story_group_id) {
    const all = await dbClient.stories.list()
    siblings = (all as unknown as RawStoryRow[])
      .filter((s) => s.story_group_id === flat.story_group_id)
      .map((s) => ({ id: s.id, language: s.language }))
  }
  return { ...flat, siblings }
}

export async function getEventStory(eventId: string): Promise<StoryWithEvents | null> {
  // The original implementation looked up via the story_events join. v0 REST
  // doesn't expose that, so list stories and find the one(s) linked to this
  // event_id. Apply the same "fewest links, then most recent" preference.
  const all = await dbClient.stories.list()
  const candidates = (all as unknown as RawStoryRow[]).filter((s) => {
    const linked = Array.isArray(s.events) ? s.events : (s.story_events ?? []).map((l) => l.events).filter(Boolean) as StoryEventLink[]
    return linked.some((e) => e.id === eventId)
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const aLen = (a.events?.length ?? (a.story_events ?? []).length)
    const bLen = (b.events?.length ?? (b.story_events ?? []).length)
    if (aLen !== bLen) return aLen - bLen
    return (b.generated_at ?? '').localeCompare(a.generated_at ?? '')
  })
  return flattenEvents(candidates[0])
}

export async function updateStory(
  id: string,
  patch: Partial<Pick<Story, 'title' | 'body' | 'cover_url'>>,
): Promise<Story> {
  const data = await dbClient.stories.update(id, patch)
  return data as unknown as Story
}

export async function deleteStory(id: string): Promise<void> {
  await dbClient.stories.delete(id)
}
