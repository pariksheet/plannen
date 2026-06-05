import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import { toLocalIso, getUserTimezone } from './_shared.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1800-1816) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'get_gcal_sync_candidates',
    description:
      'Return all going events not yet synced to Google Calendar. Each item includes gcal_start/gcal_end as local datetime strings (no UTC offset) in gcal_timezone (IANA, e.g. "Europe/Brussels"). Pass both gcal_start and gcal_timezone to Google Calendar create_event so the event shows at the correct local time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_gcal_event_id',
    description: 'Store the Google Calendar event ID on a Plannen event after syncing. Pass null to clear it.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
        gcal_event_id: {
          type: ['string', 'null'],
          description: 'GCal event ID returned by create_event, or null to clear',
        },
      },
      required: ['event_id', 'gcal_event_id'],
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

const getGcalSyncCandidates: ToolHandler = async (_args, ctx) => {
  const tz = await getUserTimezone(ctx.client, ctx.userId)
  const { rows: events } = await ctx.client.query(
    `SELECT id, title, description, start_date, end_date, location, event_kind, hashtags, enrollment_url
     FROM plannen.events
     WHERE created_by = $1 AND event_status = 'going'
       AND gcal_event_id IS NULL AND recurrence_rule IS NULL
     ORDER BY start_date ASC`,
    [ctx.userId],
  )
  if (events.length === 0) return []
  const ids = (events as Array<{ id: string }>).map((e) => e.id)
  const { rows: rsvps } = await ctx.client.query(
    `SELECT event_id, preferred_visit_date FROM plannen.event_rsvps
     WHERE user_id = $1 AND event_id = ANY($2)`,
    [ctx.userId, ids],
  )
  const visitMap = new Map<string, string | null>()
  for (const r of rsvps as Array<{ event_id: string; preferred_visit_date: string | null }>) {
    visitMap.set(r.event_id, r.preferred_visit_date)
  }
  return (
    events as Array<{
      id: string
      title: string
      description: string | null
      location: string | null
      enrollment_url: string | null
      event_kind: string
      start_date: string
      end_date: string | null
    }>
  ).map((e) => {
    const preferredDateRaw = visitMap.get(e.id) ?? null
    const preferredDate: string | null = preferredDateRaw
      ? typeof preferredDateRaw === 'string'
        ? preferredDateRaw.slice(0, 10)
        : new Date(preferredDateRaw).toISOString().slice(0, 10)
      : null
    const startStr = typeof e.start_date === 'string' ? e.start_date : new Date(e.start_date).toISOString()
    const endStr = e.end_date
      ? typeof e.end_date === 'string'
        ? e.end_date
        : new Date(e.end_date).toISOString()
      : null
    const isMultiDay = !!endStr && startStr.slice(0, 10) !== endStr.slice(0, 10)
    const useVisitDate = preferredDate && isMultiDay

    const gcal_start = useVisitDate ? `${preferredDate}T00:00:00` : toLocalIso(startStr, tz)
    const gcal_end = useVisitDate ? `${preferredDate}T23:59:59` : endStr ? toLocalIso(endStr, tz) : null

    return {
      id: e.id,
      title: e.title,
      description: e.description,
      location: e.location,
      enrollment_url: e.enrollment_url,
      event_kind: e.event_kind,
      gcal_start,
      gcal_end,
      gcal_timezone: tz,
      preferred_visit_date: preferredDate,
    }
  })
}

const setGcalEventId: ToolHandler = async (args, ctx) => {
  const { event_id, gcal_event_id } = args as { event_id: string; gcal_event_id: string | null }
  await ctx.client.query(
    `UPDATE plannen.events SET gcal_event_id = $1
     WHERE id = $2 AND created_by = $3`,
    [gcal_event_id, event_id, ctx.userId],
  )
  return { success: true, event_id, gcal_event_id }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const gcalModule: ToolModule = {
  definitions,
  dispatch: {
    get_gcal_sync_candidates: getGcalSyncCandidates,
    set_gcal_event_id: setGcalEventId,
  },
}
