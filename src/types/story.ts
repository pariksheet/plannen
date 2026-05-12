export interface StoryEventLink {
  id: string
  title: string | null
  start_date: string | null
}

export interface Story {
  id: string
  user_id: string
  story_group_id: string
  language: string
  title: string
  body: string
  cover_url: string | null
  user_notes: string | null
  mood: string | null
  tone: string | null
  date_from: string | null
  date_to: string | null
  generated_at: string
  edited_at: string | null
  created_at: string
  updated_at: string
}

export interface StorySibling {
  id: string
  language: string
}

export interface StoryWithEvents extends Story {
  events: StoryEventLink[]
}

export interface StoryWithEventsAndSiblings extends StoryWithEvents {
  siblings: StorySibling[]
}
