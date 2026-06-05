import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1914-1961) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'get_event_watch_task',
    description:
      'Get the watch task for a specific event (if one exists). Returns task status, last checked time, and whether there is an unread update.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_watch_queue',
    description:
      'Return all watched events due for checking (next_check <= now, status = active). Call this at session start to know if any events need checking. Returns empty array if nothing is due — stay silent in that case.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_watch_task',
    description:
      'Save results after checking a watched event. Call this after fetching the enrollment URL and comparing to last_result. Set has_unread_update=true and update_summary when something changed. Compute next_check based on event proximity: >6 months → +7 days, 1-6 months → +2 days, <1 month → +1 day. Set status=failed and stop if fail_count reaches 3. When confirmed dates change, update last_occurrence_date to the new confirmed start date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'agent_tasks UUID' },
        last_result: {
          type: 'object',
          description: 'Extracted details: { dates?, price?, enrollment_open?, deadline?, notes? }',
        },
        last_page_hash: {
          type: 'string',
          description: 'Short hash or fingerprint of page content for future diffing',
        },
        next_check: { type: 'string', description: 'ISO timestamp for next scheduled check' },
        fail_count: {
          type: 'number',
          description: 'Consecutive failure count (reset to 0 on success, increment on fetch error)',
        },
        has_unread_update: { type: 'boolean', description: 'Set true when content changed since last check' },
        update_summary: {
          type: 'string',
          description: 'Human-readable summary shown as badge (e.g. "Registration now open · €450/week")',
        },
        status: {
          type: 'string',
          enum: ['active', 'failed'],
          description: 'Set failed when fail_count reaches 3',
        },
        recurrence_months: {
          type: 'number',
          description: 'How often the event repeats in months (12=annual, 6=biannual, omit if unknown)',
        },
        last_occurrence_date: {
          type: 'string',
          description:
            'ISO date of the most recent confirmed occurrence — update when new confirmed dates are found',
        },
      },
      required: ['task_id', 'last_result', 'last_page_hash', 'next_check', 'fail_count', 'has_unread_update'],
    },
  },
  {
    name: 'create_watch_task',
    description:
      'Create (or reactivate) a recurring watch task for an event. Use when the user wants to watch an event that has no watch task yet. Upserts on event_id+task_type so it is safe to call on existing events.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
        recurrence_months: {
          type: 'number',
          description: 'How often the event repeats in months (12=annual, 6=biannual, omit if unknown)',
        },
        last_occurrence_date: {
          type: 'string',
          description: 'ISO date of the most recent known occurrence (e.g. "2026-01-09")',
        },
      },
      required: ['event_id'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const getEventWatchTask: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string }
  const { rows } = await ctx.client.query(
    `SELECT id, event_id, task_type, status, next_check, last_checked_at,
            last_result, fail_count, has_unread_update, update_summary,
            recurrence_months, last_occurrence_date
     FROM plannen.agent_tasks
     WHERE event_id = $1 AND task_type = ANY(ARRAY['recurring_check','enrollment_monitor'])
     ORDER BY created_at DESC
     LIMIT 1`,
    [a.event_id],
  )
  const data = rows[0] as { event_id: string } | undefined
  if (!data) return null
  // Verify the event belongs to this user
  const { rows: evRows } = await ctx.client.query(
    'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
    [data.event_id, ctx.userId],
  )
  if (evRows.length === 0) return null
  return data
}

const getWatchQueue: ToolHandler = async (_args, ctx) => {
  const now = new Date().toISOString()
  const { rows: userEvents } = await ctx.client.query(
    `SELECT id, title, enrollment_url, start_date
     FROM plannen.events WHERE created_by = $1`,
    [ctx.userId],
  )
  const eventIds = (userEvents as Array<{ id: string }>).map((e) => e.id)
  if (!eventIds.length) return []
  const { rows: tasks } = await ctx.client.query(
    `SELECT id, event_id, task_type, last_result, last_page_hash, last_checked_at,
            recurrence_months, last_occurrence_date
     FROM plannen.agent_tasks
     WHERE task_type = ANY(ARRAY['recurring_check','enrollment_monitor'])
       AND status = 'active'
       AND next_check <= $1
       AND event_id = ANY($2)`,
    [now, eventIds],
  )
  type EventLite = { id: string; title: string; enrollment_url: string | null; start_date: string }
  const eventMap = new Map<string, EventLite>(
    (userEvents as EventLite[]).map((e) => [e.id, e]),
  )
  return (
    tasks as Array<{
      id: string
      event_id: string
      task_type: string
      last_result: unknown
      last_page_hash: string | null
      last_checked_at: string | null
      recurrence_months: number | null
      last_occurrence_date: string | null
    }>
  ).map((task) => {
    const event = eventMap.get(task.event_id)
    return {
      id: task.id,
      event_id: task.event_id,
      event_title: event?.title ?? null,
      enrollment_url: event?.enrollment_url ?? null,
      start_date: event?.start_date ?? null,
      task_type: task.task_type,
      last_result: task.last_result,
      last_page_hash: task.last_page_hash,
      last_checked_at: task.last_checked_at,
      recurrence_months: task.recurrence_months,
      last_occurrence_date: task.last_occurrence_date,
    }
  })
}

const updateWatchTask: ToolHandler = async (args, ctx) => {
  const a = args as {
    task_id: string
    last_result: Record<string, unknown>
    last_page_hash: string
    next_check: string
    fail_count: number
    has_unread_update: boolean
    update_summary?: string
    status?: 'active' | 'failed'
    recurrence_months?: number
    last_occurrence_date?: string
  }
  const { rows: ownership } = await ctx.client.query(
    'SELECT event_id FROM plannen.agent_tasks WHERE id = $1',
    [a.task_id],
  )
  const owner = ownership[0] as { event_id: string } | undefined
  if (!owner) throw new Error('Watch task not found')
  const { rows: ownedEvent } = await ctx.client.query(
    'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
    [owner.event_id, ctx.userId],
  )
  if (ownedEvent.length === 0) throw new Error('Not authorised to update this watch task')

  const setClauses: string[] = []
  const params: unknown[] = []
  const push = (col: string, val: unknown) => {
    params.push(val)
    setClauses.push(`${col} = $${params.length}`)
  }
  push('last_result', a.last_result)
  push('last_page_hash', a.last_page_hash)
  push('last_checked_at', new Date().toISOString())
  push('next_check', a.next_check)
  push('fail_count', a.fail_count)
  push('has_unread_update', a.has_unread_update)
  push('updated_at', new Date().toISOString())
  if (a.update_summary !== undefined) push('update_summary', a.update_summary)
  if (a.status !== undefined) push('status', a.status)
  if (a.recurrence_months !== undefined) push('recurrence_months', a.recurrence_months)
  if (a.last_occurrence_date !== undefined) push('last_occurrence_date', a.last_occurrence_date)
  params.push(a.task_id)
  await ctx.client.query(
    `UPDATE plannen.agent_tasks SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
    params,
  )
  return { success: true }
}

const createWatchTask: ToolHandler = async (args, ctx) => {
  const a = args as {
    event_id: string
    recurrence_months?: number
    last_occurrence_date?: string
  }
  const { rows: evRows } = await ctx.client.query(
    'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
    [a.event_id, ctx.userId],
  )
  if (evRows.length === 0) throw new Error('Event not found or not authorised')

  const cols = ['event_id', 'task_type', 'status', 'next_check']
  const vals: unknown[] = [a.event_id, 'recurring_check', 'active', new Date().toISOString()]
  const updateSets: string[] = ['status = EXCLUDED.status', 'next_check = EXCLUDED.next_check']
  if (a.recurrence_months !== undefined) {
    cols.push('recurrence_months')
    vals.push(a.recurrence_months)
    updateSets.push('recurrence_months = EXCLUDED.recurrence_months')
  }
  if (a.last_occurrence_date !== undefined) {
    cols.push('last_occurrence_date')
    vals.push(a.last_occurrence_date)
    updateSets.push('last_occurrence_date = EXCLUDED.last_occurrence_date')
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.agent_tasks (${cols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (event_id, task_type) DO UPDATE
       SET ${updateSets.join(', ')}
     RETURNING id`,
    vals,
  )
  return { success: true, task_id: (rows[0] as { id: string } | undefined)?.id }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const watchesModule: ToolModule = {
  definitions,
  dispatch: {
    get_event_watch_task: getEventWatchTask,
    get_watch_queue: getWatchQueue,
    update_watch_task: updateWatchTask,
    create_watch_task: createWatchTask,
  },
}
