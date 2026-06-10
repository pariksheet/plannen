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

// ── Phase 3: override resolution + obligation projection ─────────────────────

export type ObligationRow = {
  id: string
  user_id: string
  derived_from_attendance_id: string
  role: 'drop' | 'pick'
  anchor: 'start' | 'end'
  offset_minutes: number
  location_id: string | null
  active: boolean
}

export type ResolvedObligation = {
  obligation_id: string
  role: 'drop' | 'pick'
  date: string
  time: string // HH:MM after anchor+offset
  location_id: string | null // obligation's own, else inherited from winning instance
  source_attendance_id: string
  source_name: string
}

/**
 * Add `minutes` (may be negative) to an HH:MM clock time and re-format.
 * No day-wrap is needed for the supported ranges, but to stay total we
 * clamp the result into [0,1440) via modulo so a stray over/underflow
 * still yields a valid HH:MM rather than a negative or out-of-range value.
 */
export function addMinutesToClock(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = ((h * 60 + m + minutes) % 1440 + 1440) % 1440
  const hh = Math.floor(total / 60)
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * Pick the single winning instance among all surviving instances for ONE
 * member on ONE date. Comparator is total + deterministic:
 *   (1) higher `priority` wins;
 *   (2) bounded (`recurrence_until != null`) beats open-ended (`== null`);
 *   (3) later `dtstart` wins (string compare);
 *   (4) lower `attendance_id` wins (string compare).
 */
export function resolveOverride(
  instances: AttendanceInstance[],
): AttendanceInstance | null {
  if (instances.length === 0) return null
  return instances.reduce((best, cur) => (beats(cur, best) ? cur : best))
}

/** True iff `a` strictly outranks `b` under the override comparator. */
function beats(a: AttendanceInstance, b: AttendanceInstance): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  const aBounded = a.recurrence_until != null
  const bBounded = b.recurrence_until != null
  if (aBounded !== bBounded) return aBounded
  if (a.dtstart !== b.dtstart) return a.dtstart > b.dtstart
  return a.attendance_id < b.attendance_id
}

/**
 * Project a linked obligation onto its winning instance. Returns null when
 * the anchored time is absent (an all-day instance can't anchor a drop/pick).
 */
export function projectObligation(
  ob: ObligationRow,
  winner: AttendanceInstance,
): ResolvedObligation | null {
  const base = ob.anchor === 'start' ? winner.start_time : winner.end_time
  if (base == null) return null
  return {
    obligation_id: ob.id,
    role: ob.role,
    date: winner.date,
    time: addMinutesToClock(base, ob.offset_minutes),
    location_id: ob.location_id ?? winner.location_id,
    source_attendance_id: winner.attendance_id,
    source_name: winner.name,
  }
}
