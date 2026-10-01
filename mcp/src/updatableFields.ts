// Update handlers build `SET <column> = $n` from argument keys, so every key
// must be a known caller-settable column. Mirrors the allowlists in
// supabase/functions/mcp/tools/{events,practices,scheduling}.ts — keep in sync.

export const UPDATE_EVENT_FIELDS = [
  'title', 'description', 'start_date', 'end_date', 'location', 'event_status', 'enrollment_url',
  'subject_kind', 'subject_id', 'owner_attends', 'group_id', 'list_label',
] as const

export const UPDATE_PRACTICE_FIELDS = [
  'name', 'category', 'recurrence_mode', 'recurrence_rule', 'dtstart', 'recurrence_until',
  'flex_period', 'flex_target', 'preferred_time_of_day', 'precise_time', 'family_member_id', 'active',
] as const

export const UPDATE_ATTENDANCE_FIELDS = [
  'family_member_id', 'name', 'location_id', 'recurrence_rule', 'dtstart', 'recurrence_until',
  'time_of_day', 'start_time', 'end_time', 'priority', 'active',
] as const

export const UPDATE_OBLIGATION_FIELDS = ['role', 'anchor', 'offset_minutes', 'location_id', 'active'] as const

// Throws on anything else, including real columns that must never be set by a
// caller (created_by, user_id).
export function assertUpdatableKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) {
    if (k === 'id') continue
    if (!allowed.includes(k)) throw new Error(`unknown field: ${k.slice(0, 64)}`)
  }
}
