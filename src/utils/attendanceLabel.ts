import type { AttendanceInstanceRow } from '../lib/dbClient/types'

/**
 * Human label for an indicative attendance instance.
 *   both times → "example school (08:30–15:30)"
 *   start only → "example school (from 08:30)"
 *   end only   → "example school (until 15:30)"
 *   neither    → "example school"
 */
export function attendanceLabel(inst: AttendanceInstanceRow): string {
  const { name, start_time, end_time } = inst
  if (start_time && end_time) return `${name} (${start_time}–${end_time})`
  if (start_time) return `${name} (from ${start_time})`
  if (end_time) return `${name} (until ${end_time})`
  return name
}
