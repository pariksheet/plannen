export type EventType = 'personal' | 'friends' | 'family' | 'group'
export type EventStatus = 'watching' | 'planned' | 'interested' | 'going' | 'cancelled' | 'past' | 'missed'
export type EventKind = 'event' | 'reminder' | 'session' | 'todo' | 'container'
export type SharedWithFriends = 'none' | 'all' | 'selected'
export type EventViewMode = 'detailed' | 'compact' | 'calendar' | 'schedule'

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
  // Legacy/UI-only sharing selector. No longer a DB column (retired in
  // 20260617180000) — real sharing lives in event_shares / shared_summary.
  shared_with_friends?: SharedWithFriends
  my_rsvp_status?: 'going' | 'maybe' | 'not_going' | null
  recurrence_rule?: Record<string, unknown> | null
  parent_event_id?: string | null
  completed_at?: string | null
  assigned_to?: string | null
  group_id?: string | null
  list_label?: string | null
  subject_kind?: 'family_member' | 'user' | null
  subject_id?: string | null
  owner_attends?: boolean
  // Enriched at query time — not DB columns
  parent_title?: string | null
  sessions_summary?: { total: number; past: number; missed: number; next_date: string | null } | null
  // Derived from event_shares at load time (the source of truth for sharing).
  shared_summary?: { groups: number; users: number; all: boolean; assigned: number } | null
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
  shared_with_friends: SharedWithFriends
  shared_with_user_ids: string[]
  shared_with_group_ids: string[]
  recurrence_rule?: Record<string, unknown> | null
}

const VALID_STATUSES: EventStatus[] = ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed']

export function resolveEventStatus(event: Event): Event {
  // Completion for todos is tracked via completed_at, never event_status — so
  // a past, unfinished todo must stay visible, not silently become past/missed.
  if (event.event_kind === 'todo') return event
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

export function isTodoOverdue(event: Event, now: Date = new Date()): boolean {
  return event.event_kind === 'todo' && !event.completed_at && new Date(event.start_date) < now
}
