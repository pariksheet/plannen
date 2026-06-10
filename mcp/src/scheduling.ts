// Pure scheduling engine for family-member attendances. No DB / IO.
// All date arguments are UTC calendar dates ("YYYY-MM-DD"). Callers must
// normalise to UTC before passing. No Date.now(): every date is supplied
// by the caller, so expansion is deterministic. Reuses the recurrence
// matcher from practices.ts (occursOn) — weekday/interval logic is NOT
// reimplemented here.

import { occursOn, type RecurrenceRule } from './practices.js'

export type { RecurrenceRule }

export type AttendanceRow = {
  id: string
  user_id: string
  family_member_id: string
  name: string
  location_id: string | null
  recurrence_rule: RecurrenceRule // pinned
  dtstart: string // YYYY-MM-DD
  recurrence_until: string | null // YYYY-MM-DD
  start_time: string | null
  end_time: string | null
  priority: number
  active: boolean
}

export type BlackoutWindow = {
  calendar_id: string
  starts_on: string // YYYY-MM-DD, inclusive
  ends_on: string // YYYY-MM-DD, inclusive
  label: string | null
}

export type AttendanceInstance = {
  attendance_id: string
  family_member_id: string
  date: string // YYYY-MM-DD
  name: string
  location_id: string | null
  start_time: string | null
  end_time: string | null
  priority: number
  dtstart: string // carried for Phase 3 override tie-break
  recurrence_until: string | null // carried for Phase 3 override tie-break
}

/** Inclusive on both ends. ISO YYYY-MM-DD compares lexicographically. */
export function dateInWindow(date: string, win: BlackoutWindow): boolean {
  return date >= win.starts_on && date <= win.ends_on
}

/** True iff ANY window covers the date. */
export function isSuppressed(date: string, windows: BlackoutWindow[]): boolean {
  return windows.some((w) => dateInWindow(date, w))
}

/** Advance a UTC YYYY-MM-DD date by one calendar day. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Expand an attendance into one instance per matching day across the
 * inclusive window [windowStart, windowEnd]. Inactive attendances expand
 * to nothing. Instances after recurrence_until are dropped.
 */
export function expandAttendance(
  att: AttendanceRow,
  windowStart: string,
  windowEnd: string,
): AttendanceInstance[] {
  const out: AttendanceInstance[] = []
  if (!att.active) return out
  for (let d = windowStart; d <= windowEnd; d = nextDay(d)) {
    if (att.recurrence_until !== null && d > att.recurrence_until) continue
    if (!occursOn(att.recurrence_rule, att.dtstart, d)) continue
    out.push({
      attendance_id: att.id,
      family_member_id: att.family_member_id,
      date: d,
      name: att.name,
      location_id: att.location_id,
      start_time: att.start_time,
      end_time: att.end_time,
      priority: att.priority,
      dtstart: att.dtstart,
      recurrence_until: att.recurrence_until,
    })
  }
  return out
}

/** expandAttendance, minus any instance falling inside a blackout window. */
export function expandAndSuppress(
  att: AttendanceRow,
  windows: BlackoutWindow[],
  windowStart: string,
  windowEnd: string,
): AttendanceInstance[] {
  return expandAttendance(att, windowStart, windowEnd).filter(
    (inst) => !isSuppressed(inst.date, windows),
  )
}
