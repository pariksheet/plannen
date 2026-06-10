import { dbClient } from '../lib/dbClient'
import { projectDay, type BlackoutWindow } from '../utils/scheduling'
import type { AttendanceInstanceRow, ResolvedObligationRow } from '../lib/dbClient/types'

// Fetch the user's RLS-scoped scheduling rows and run the pure projection
// engine in the browser for a single day (the web has no get_briefing_context
// route). Returns the two read-only lists the schedule card renders.
export async function projectScheduleForDay(date: string): Promise<{
  attendancesToday: AttendanceInstanceRow[]
  obligationsToday: ResolvedObligationRow[]
}> {
  const [attendances, windowRows, obligations] = await Promise.all([
    dbClient.scheduling.listAttendances(),
    dbClient.scheduling.listAttendanceBlackoutWindows(),
    dbClient.scheduling.listObligationsWithMember(),
  ])

  const windowsByAttendance = new Map<string, BlackoutWindow[]>()
  for (const w of windowRows) {
    const list = windowsByAttendance.get(w.attendance_id) ?? []
    list.push({ calendar_id: w.calendar_id, starts_on: w.starts_on, ends_on: w.ends_on, label: w.label })
    windowsByAttendance.set(w.attendance_id, list)
  }

  return projectDay(date, attendances, windowsByAttendance, obligations)
}
