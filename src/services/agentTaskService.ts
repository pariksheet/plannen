import { dbClient } from '../lib/dbClient'

export async function createRecurringTask(
  eventId: string,
  enrollmentUrl: string,
  opts?: { recurrenceMonths?: number; lastOccurrenceDate?: string }
): Promise<void> {
  await dbClient.agentTasks.create({
    event_id: eventId,
    task_type: 'recurring_check',
    status: 'active',
    next_check: new Date().toISOString(),
    metadata: { enrollment_url: enrollmentUrl },
    ...(opts?.recurrenceMonths !== undefined && { recurrence_months: opts.recurrenceMonths }),
    ...(opts?.lastOccurrenceDate !== undefined && { last_occurrence_date: opts.lastOccurrenceDate }),
  })
}

export async function createEnrollmentMonitorTask(eventId: string): Promise<void> {
  await dbClient.agentTasks.create({
    event_id: eventId,
    task_type: 'enrollment_monitor',
    status: 'active',
    next_check: new Date().toISOString(),
  })
}

export interface WatchTask {
  id: string
  event_id: string
  task_type: string
  status: string
  next_check: string | null
  last_checked_at: string | null
  last_result: Record<string, unknown> | null
  fail_count: number
  has_unread_update: boolean
  update_summary: string | null
  recurrence_months: number | null
  last_occurrence_date: string | null
}

export async function getEventWatchTask(eventId: string): Promise<WatchTask | null> {
  const rows = await dbClient.watch.list({ event_id: eventId })
  if (!rows.length) return null
  // The backend already orders by next_check; mirror the old "first row" behaviour.
  return rows[0] as unknown as WatchTask
}

export async function acknowledgeWatchUpdate(taskId: string): Promise<void> {
  await dbClient.watch.update(taskId, { has_unread_update: false })
}
