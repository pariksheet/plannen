import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import { getUserTimezone } from './_shared.ts'
import { parseInUserTz } from '../../_shared/recurrence.ts'

// Generic "what I did / measured" log (Phase 2 of /log). `activity` is a
// free-form label — never an enum. A row carries a duration OR a quantity+unit
// (or neither). log_activity also ticks a conservatively-matched active routine
// server-side (the "both" rule) so the streak follows the data without the
// client making a second call — robust on mobile.

const definitions: ToolDefinition[] = [
  {
    name: 'log_activity',
    description:
      'CALL THIS IMMEDIATELY, without asking, when the user reports doing something with a DURATION or a measured QUANTITY — even casually ("slept 8h last night", "ran 40 min", "drank 2L water", "weight 72kg", "mood 4/5", "2h deep work this morning", "read to the kids 20 min"). Do NOT just reply conversationally — log it, then confirm in one line ending "· undo?". `activity` is a free label from the user\'s words (never a fixed category). Put time-spans in duration_minutes (8h → 480) and measures in quantity+unit (2 + "L"). It resolves coarse times ("last night", "this morning") to occurred_at in the profile timezone (default now), and if an active routine matches the activity it ALSO marks that routine done (returns marked_routine). Use log_completion instead for a bare "done X" with no duration/quantity; use create_event for a FUTURE task; use upsert_profile_fact for a durable fact about a person/place.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', description: 'Free-form label, e.g. "sleep", "run", "water", "weight", "mood". Keep it short so it matches routines and groups in queries.' },
        occurred_at: { type: 'string', description: 'ISO date/datetime it happened (naive = profile timezone). Defaults to now.' },
        duration_minutes: { type: 'number', description: 'For time-blocks: slept 8h → 480, ran 40 min → 40.' },
        quantity: { type: 'number', description: 'For measures: 2 (litres), 72 (kg), 4 (/5), 8000 (steps).' },
        unit: { type: 'string', description: 'Unit for quantity, e.g. "L", "kg", "/5", "steps", "pages".' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        family_member_id: { type: ['string', 'null'], description: 'Set when logging for a circle member.' },
      },
      required: ['activity'],
    },
  },
  {
    name: 'list_activity_logs',
    description:
      'List logged activities (newest first) so you can answer "how much did I sleep this week" / "how often do I run" by summing or counting the rows yourself. Filter by activity label (exact, case-insensitive), occurred_at date range, and/or family member.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', description: 'Exact label match (case-insensitive), e.g. "sleep".' },
        from: { type: 'string', description: 'ISO date — only rows with occurred_at on/after this.' },
        to: { type: 'string', description: 'ISO date — only rows with occurred_at on/before this.' },
        family_member_id: { type: ['string', 'null'] },
        limit: { type: 'number', description: 'Max rows (default 100).' },
      },
    },
  },
  {
    name: 'delete_activity_log',
    description: 'Delete one logged activity by id — the undo path for log_activity. If that log also ticked a routine, also call unmark_practice_done to fully undo.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'activity_logs row UUID' } },
      required: ['id'],
    },
  },
]

const logActivity: ToolHandler = async (args, ctx) => {
  const a = args as {
    activity?: string; occurred_at?: string; duration_minutes?: number
    quantity?: number; unit?: string; notes?: string; tags?: string[]; family_member_id?: string | null
  }
  if (!a.activity || !a.activity.trim()) throw new Error('activity is required')
  const activity = a.activity.trim()
  const norm = activity.toLowerCase()
  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const occurredAt = a.occurred_at ? parseInUserTz(a.occurred_at, tz) : new Date()
  const occurredIso = occurredAt.toISOString()
  const completedOn = a.occurred_at && /^\d{4}-\d{2}-\d{2}$/.test(a.occurred_at) ? a.occurred_at : occurredIso.slice(0, 10)

  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.activity_logs
       (user_id, family_member_id, activity, occurred_at, duration_minutes, quantity, unit, notes, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      ctx.userId,
      a.family_member_id ?? null,
      activity,
      occurredIso,
      a.duration_minutes ?? null,
      a.quantity ?? null,
      a.unit ?? null,
      a.notes ?? null,
      a.tags ?? [],
    ],
  )
  const row = rows[0]

  // "Both" rule: tick a conservatively-matched active routine (single match only).
  const normOf = (v: unknown) => String(v ?? '').trim().toLowerCase()
  const practiceParams: unknown[] = [ctx.userId]
  let practiceWhere = 'user_id = $1 AND active = true'
  if (a.family_member_id !== undefined && a.family_member_id !== null) {
    practiceParams.push(a.family_member_id)
    practiceWhere += ` AND family_member_id = $${practiceParams.length}`
  }
  const { rows: practices } = await ctx.client.query(
    `SELECT id, name, family_member_id FROM plannen.practices WHERE ${practiceWhere}`,
    practiceParams,
  )
  type PracticeMatch = { id: string; name: string; family_member_id: string | null }
  const pExact = practices.filter((r) => normOf((r as { name: unknown }).name) === norm)
  let pMatch: PracticeMatch | null = null
  if (pExact.length === 1) pMatch = pExact[0] as PracticeMatch
  else if (pExact.length === 0) {
    const pContains = practices.filter((r) => normOf((r as { name: unknown }).name).includes(norm))
    if (pContains.length === 1) pMatch = pContains[0] as PracticeMatch
  }
  let marked_routine: { practice_id: string; name: string } | null = null
  if (pMatch) {
    await ctx.client.query(
      `INSERT INTO plannen.practice_completions (practice_id, user_id, family_member_id, completed_on)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [pMatch.id, ctx.userId, pMatch.family_member_id ?? null, completedOn],
    )
    marked_routine = { practice_id: pMatch.id, name: pMatch.name }
  }

  return { ...row, marked_routine }
}

const listActivityLogs: ToolHandler = async (args, ctx) => {
  const a = args as { activity?: string; from?: string; to?: string; family_member_id?: string | null; limit?: number }
  const params: unknown[] = [ctx.userId]
  const where: string[] = ['user_id = $1']
  if (a.activity) {
    params.push(a.activity.trim().toLowerCase())
    where.push(`lower(activity) = $${params.length}`)
  }
  if (a.from) {
    params.push(a.from)
    where.push(`occurred_at >= $${params.length}`)
  }
  if (a.to) {
    params.push(a.to)
    where.push(`occurred_at <= ($${params.length}::date + interval '1 day')`)
  }
  if (a.family_member_id !== undefined) {
    if (a.family_member_id === null) where.push('family_member_id is null')
    else {
      params.push(a.family_member_id)
      where.push(`family_member_id = $${params.length}`)
    }
  }
  params.push(Math.min(a.limit ?? 100, 500))
  const { rows } = await ctx.client.query(
    `SELECT id, family_member_id, activity, occurred_at, duration_minutes, quantity, unit, notes, tags, created_at
     FROM plannen.activity_logs
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return rows
}

const deleteActivityLog: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const { rowCount } = await ctx.client.query(
    `DELETE FROM plannen.activity_logs WHERE id = $1 AND user_id = $2`,
    [a.id, ctx.userId],
  )
  if (rowCount === 0) throw new Error('activity log not found')
  return { ok: true, id: a.id }
}

export const activityModule: ToolModule = {
  definitions,
  dispatch: {
    log_activity: logActivity,
    list_activity_logs: listActivityLogs,
    delete_activity_log: deleteActivityLog,
  },
}
