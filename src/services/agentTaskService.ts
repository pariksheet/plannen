import { supabase } from '../lib/supabase'

export async function createRecurringTask(
  eventId: string,
  enrollmentUrl: string,
  opts?: { recurrenceMonths?: number; lastOccurrenceDate?: string }
): Promise<void> {
  await supabase.from('agent_tasks').upsert(
    {
      event_id: eventId,
      task_type: 'recurring_check',
      status: 'active',
      next_check: new Date().toISOString(),
      metadata: { enrollment_url: enrollmentUrl },
      ...(opts?.recurrenceMonths !== undefined && { recurrence_months: opts.recurrenceMonths }),
      ...(opts?.lastOccurrenceDate !== undefined && { last_occurrence_date: opts.lastOccurrenceDate }),
    },
    { onConflict: 'event_id,task_type', ignoreDuplicates: false }
  ).select()
}

export async function createEnrollmentMonitorTask(eventId: string): Promise<void> {
  await supabase.from('agent_tasks').upsert(
    {
      event_id: eventId,
      task_type: 'enrollment_monitor',
      status: 'active',
      next_check: new Date().toISOString(),
    },
    { onConflict: 'event_id,task_type', ignoreDuplicates: false }
  ).select()
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
  const { data, error } = await supabase
    .from('agent_tasks')
    .select('id, event_id, task_type, status, next_check, last_checked_at, last_result, fail_count, has_unread_update, update_summary, recurrence_months, last_occurrence_date')
    .eq('event_id', eventId)
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ?? null
}

export async function acknowledgeWatchUpdate(taskId: string): Promise<void> {
  const { error } = await supabase
    .from('agent_tasks')
    .update({ has_unread_update: false })
    .eq('id', taskId)
  if (error) throw new Error(error.message)
}
