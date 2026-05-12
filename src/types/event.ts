export type EventType = 'personal' | 'friends' | 'family' | 'group'
export type EventStatus = 'watching' | 'planned' | 'interested' | 'going' | 'cancelled' | 'past' | 'missed'
export type EventKind = 'event' | 'reminder' | 'session'
export type SharedWithFriends = 'none' | 'all' | 'selected'
export type EventViewMode = 'detailed' | 'compact' | 'calendar'

export interface Event {
  id: string
  title: string
  description: string | null
  start_date: string
  end_date: string | null
  enrollment_url: string | null
  enrollment_deadline: string | null
  enrollment_start_date: string | null
  image_url: string | null
  location: string | null
  hashtags: string[] | null
  event_kind: EventKind
  event_type: EventType
  event_status: EventStatus
  created_by: string
  created_at: string
  updated_at: string
  shared_with_family: boolean
  shared_with_friends: SharedWithFriends
  my_rsvp_status?: 'going' | 'maybe' | 'not_going' | null
  recurrence_rule?: Record<string, unknown> | null
  parent_event_id?: string | null
  // Enriched at query time — not DB columns
  parent_title?: string | null
  sessions_summary?: { total: number; past: number; missed: number; next_date: string | null } | null
}

export interface EventFormData {
  title: string
  description: string
  start_date: string
  end_date: string
  enrollment_url: string
  enrollment_deadline: string
  enrollment_start_date: string
  image_url: string
  location: string
  hashtags: string[]
  event_kind: EventKind
  event_type: EventType
  event_status?: EventStatus
  shared_with_family: boolean
  shared_with_friends: SharedWithFriends
  shared_with_user_ids: string[]
  shared_with_group_ids: string[]
  recurrence_rule?: Record<string, unknown> | null
}

const VALID_STATUSES: EventStatus[] = ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed']

export function resolveEventStatus(event: Event): Event {
  const raw = event.event_status
  const status = typeof raw === 'string' && VALID_STATUSES.includes(raw as EventStatus) ? (raw as EventStatus) : null
  if (!status) return event
  const now = new Date()
  const start = new Date(event.start_date)
  // Never auto-transition a multi-day event that is still ongoing
  if (event.end_date && new Date(event.end_date) > now) return event
  // Don't flip events that started today — they stay in the timeline as "past today"
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (start >= startOfToday) return event
  if (start < now && status === 'interested') return { ...event, event_status: 'missed' }
  if (start < now && status === 'going') return { ...event, event_status: 'past' }
  return event
}
