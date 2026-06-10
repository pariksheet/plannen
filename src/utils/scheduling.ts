// NOTE: pure scheduling engine mirrored from mcp/src/scheduling.ts (+ occursOn from mcp/src/practices.ts). Keep in sync; canonical source is mcp/src. Web build can't import across packages (tsconfig includes only src).
//
// The web tsconfig includes only `src`/`tests`, so we cannot import the
// canonical engine. The exported functions below are BYTE-IDENTICAL copies of
// the canonical ones (expandAttendance, expandAndSuppress, resolveOverride,
// projectObligation, addMinutesToClock, dateInWindow, isSuppressed) plus the
// occursOn + date helpers occursOn depends on. `projectDay` is web-only and
// mirrors the getBriefingContext pipeline in mcp/src/index.ts.

import type {
  AttendanceRow,
  ObligationRow,
  AttendanceInstanceRow,
  ResolvedObligationRow,
} from '../lib/dbClient/types'

// ── date helpers + occursOn (mirrored from mcp/src/practices.ts) ─────────────

export type RecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval?: number
  days?: string[] // two-letter codes: MO,TU,WE,TH,FR,SA,SU (same as events)
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
// RecurrenceRule.days uses two-letter codes; map to the ISO weekday name.
const CODE_TO_KEY: Record<string, typeof DAY_KEYS[number]> = {
  SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat',
}

function midnightUtcMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime()
}

function daysBetween(a: string, b: string): number {
  return Math.round((midnightUtcMs(b) - midnightUtcMs(a)) / 86_400_000)
}

/** ISO weekday: Mon=1..Sun=7. */
function weekday(date: string): number {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  return js === 0 ? 7 : js
}

/** Returns the Monday of the ISO week containing `date`, as "YYYY-MM-DD". */
export function weekBoundaryStart(date: string): string {
  const wd = weekday(date)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

/** "mon"/"tue"/.../"sun" for an ISO date. */
export function dayOfWeekKey(date: string): typeof DAY_KEYS[number] {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay()
  return DAY_KEYS[js]
}

/**
 * Does `rule` (anchored at `dtstart`) produce an occurrence on `date`?
 * Interval is counted from `dtstart`: every-2-days from Jun 1 lands on
 * Jun 1, 3, 5… Weekly interval is counted in whole ISO weeks; monthly in
 * whole calendar months on the same day-of-month as the anchor.
 */
export function occursOn(rule: RecurrenceRule, dtstart: string, date: string): boolean {
  if (date < dtstart) return false
  const interval = rule.interval ?? 1
  switch (rule.frequency) {
    case 'daily': {
      const diff = daysBetween(dtstart, date)
      return diff >= 0 && diff % interval === 0
    }
    case 'weekly': {
      const key = dayOfWeekKey(date)
      const days = (rule.days ?? []).map((c) => CODE_TO_KEY[c]).filter(Boolean)
      if (!days.includes(key)) return false
      const weeks = Math.round(daysBetween(weekBoundaryStart(dtstart), weekBoundaryStart(date)) / 7)
      return weeks >= 0 && weeks % interval === 0
    }
    case 'monthly': {
      if (date.slice(8, 10) !== dtstart.slice(8, 10)) return false
      const months =
        (Number(date.slice(0, 4)) - Number(dtstart.slice(0, 4))) * 12 +
        (Number(date.slice(5, 7)) - Number(dtstart.slice(5, 7)))
      return months >= 0 && months % interval === 0
    }
  }
}

// ── scheduling engine (mirrored from mcp/src/scheduling.ts) ──────────────────

export type BlackoutWindow = {
  calendar_id: string
  starts_on: string // YYYY-MM-DD, inclusive
  ends_on: string // YYYY-MM-DD, inclusive
  label: string | null
}

// AttendanceInstance is structurally identical to the web AttendanceInstanceRow.
type AttendanceInstance = AttendanceInstanceRow

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

export type ResolvedObligation = ResolvedObligationRow

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

// ── web-only high-level projection (mirrors getBriefingContext) ──────────────

/**
 * Project a single UTC day. Mirrors the attendances_today / obligations_today
 * pipeline in mcp/src/index.ts getBriefingContext:
 *  • expandAndSuppress each attendance over [date, date] → attendancesToday
 *  • group surviving instances by family member, resolveOverride → winner
 *  • "follow the child": each obligation projects onto its MEMBER's winning
 *    instance for the day (not necessarily the attendance it derives from),
 *    so a bounded camp that outranks the open-ended school re-projects the
 *    school-derived drop/pick onto the camp instance.
 */
export function projectDay(
  date: string,
  attendances: AttendanceRow[],
  windowsByAttendance: Map<string, BlackoutWindow[]>,
  obligations: (ObligationRow & { member_id: string })[],
): { attendancesToday: AttendanceInstanceRow[]; obligationsToday: ResolvedObligationRow[] } {
  const attendancesToday = attendances.flatMap((att) =>
    expandAndSuppress(att, windowsByAttendance.get(att.id) ?? [], date, date),
  )

  const instancesByMember = new Map<string, AttendanceInstance[]>()
  for (const inst of attendancesToday) {
    const list = instancesByMember.get(inst.family_member_id) ?? []
    list.push(inst)
    instancesByMember.set(inst.family_member_id, list)
  }
  const winnerByMember = new Map<string, AttendanceInstance>()
  for (const [memberId, instances] of instancesByMember) {
    const winner = resolveOverride(instances)
    if (winner) winnerByMember.set(memberId, winner)
  }

  const obligationsToday = obligations
    .flatMap((ob) => {
      const winner = winnerByMember.get(ob.member_id)
      if (!winner) return []
      const resolved = projectObligation(ob, winner)
      return resolved ? [resolved] : []
    })
    .filter((r) => r.date === date)

  return { attendancesToday, obligationsToday }
}
