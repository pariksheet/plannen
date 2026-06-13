import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import { isPracticeDueOn, remainingThisPeriod, weekBoundaryStart } from '../../_shared/practices.ts'
import { expandAndSuppress, resolveOverride, projectObligation, type AttendanceRow, type AttendanceInstance, type BlackoutWindow, type ObligationRow } from '../../_shared/scheduling.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2422-2455) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'get_briefing_context',
    description: 'Composite snapshot for composing the daily briefing — events today + tomorrow, recent past events, your circle, practices due today (with weekly remaining counts), and locations. One round-trip. Use this before composing a /plannen-today briefing.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date; defaults to today.' },
      },
    },
  },
  {
    name: 'save_daily_briefing',
    description: 'Persist the composed daily briefing. Upserts on (user_id, briefing_date) — a second save on the same date overwrites. Content is markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        briefing_date: { type: 'string' },
        content_md: { type: 'string' },
        summary: { type: 'string' },
        source: { type: 'string', enum: ['claude_code', 'claude_desktop', 'web', 'cron'] },
      },
      required: ['briefing_date', 'content_md', 'source'],
    },
  },
  {
    name: 'get_daily_briefing',
    description: 'Fetch the persisted briefing for a date (default today). Returns null if none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date; defaults to today.' },
      },
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Composite read for the daily briefing. `args.date` is a UTC calendar date
 * (`YYYY-MM-DD`); pass `new Date().toISOString().slice(0, 10)` from the
 * caller. A locale-derived date string may resolve to the wrong day for users
 * far from UTC.
 */
const getBriefingContext: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const typedArgs = args as { date?: string }
  const today = typedArgs.date ?? new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`)
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7)
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10)
  const wkStart = weekBoundaryStart(today)
  const monthStart = `${today.slice(0, 7)}-01`
  const completionsFrom = monthStart < wkStart ? monthStart : wkStart

  const [userRow, circleRow, primaryCircleUsersRow, eventsTodayRow, eventsTomorrowRow, recentPastRow, practicesRow, completionsRow, locationsRow, attendancesRow, blackoutsRow, obligationsRow] =
    await Promise.all([
      ctx.client.query(
        `SELECT u.id, u.full_name, u.preferred_language, up.timezone, up.primary_circle_group_ids
         FROM plannen.users u
         LEFT JOIN plannen.user_profiles up ON up.user_id = u.id
         WHERE u.id = $1`,
        [id],
      ),
      ctx.client.query(
        `SELECT id, name, relation, dob, gender, goals, interests
         FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC`,
        [id],
      ),
      ctx.client.query(
        `SELECT DISTINCT u.id, u.full_name, u.email
           FROM plannen.user_profiles up
           JOIN plannen.friend_group_members fgm
             ON fgm.group_id = ANY(up.primary_circle_group_ids)
           JOIN plannen.users u ON u.id = fgm.user_id
          WHERE up.user_id = $1
            AND u.id <> $1`,
        [id],
      ),
      ctx.client.query(
        `SELECT id, title, start_date, end_date, location, event_kind, hashtags, subject_kind, subject_id, owner_attends
         FROM plannen.events
         WHERE created_by = $1 AND start_date::date = $2::date
           AND event_status <> 'cancelled'
         ORDER BY start_date ASC`,
        [id, today],
      ),
      ctx.client.query(
        `SELECT id, title, start_date, end_date, location, event_kind, hashtags, subject_kind, subject_id, owner_attends
         FROM plannen.events
         WHERE created_by = $1 AND start_date::date = $2::date
           AND event_status <> 'cancelled'
         ORDER BY start_date ASC`,
        [id, tomorrowStr],
      ),
      ctx.client.query(
        `SELECT id, title, start_date, location, event_kind
         FROM plannen.events
         WHERE created_by = $1
           AND start_date::date BETWEEN $2::date AND ($3::date - INTERVAL '1 day')::date
           AND event_status <> 'cancelled'
         ORDER BY start_date DESC LIMIT 10`,
        [id, sevenDaysAgoStr, today],
      ),
      ctx.client.query(
        `SELECT id, family_member_id, name, category, recurrence_mode, recurrence_rule,
                dtstart::text, recurrence_until::text, flex_period, flex_target,
                preferred_time_of_day, active
         FROM plannen.practices WHERE user_id = $1 AND active = true`,
        [id],
      ),
      ctx.client.query(
        `SELECT practice_id, completed_on::text
         FROM plannen.practice_completions
         WHERE user_id = $1 AND completed_on >= $2::date`,
        [id, completionsFrom],
      ),
      ctx.client.query(
        `SELECT id, label, city, country, is_default
         FROM plannen.user_locations WHERE user_id = $1`,
        [id],
      ),
      ctx.client.query(
        `SELECT id, family_member_id, name, location_id, recurrence_rule,
                dtstart::text, recurrence_until::text, start_time, end_time, priority, active
         FROM plannen.attendances WHERE user_id = $1 AND active = true`,
        [id],
      ),
      ctx.client.query(
        `SELECT ab.attendance_id, w.calendar_id, w.starts_on::text AS starts_on,
                w.ends_on::text AS ends_on, w.label
         FROM plannen.attendance_blackouts ab
         JOIN plannen.blackout_windows w ON w.calendar_id = ab.calendar_id
         WHERE ab.user_id = $1`,
        [id],
      ),
      ctx.client.query(
        `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
                o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
         FROM plannen.obligations o
         JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
         WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
        [id],
      ),
    ])

  type CRow = { practice_id: string; completed_on: string }
  const allCompletions = completionsRow.rows as CRow[]
  const practicesDue = (practicesRow.rows as Parameters<typeof isPracticeDueOn>[0][])
    .filter((p) => isPracticeDueOn(p, today, allCompletions))
    .map((p) => {
      const inPeriod = allCompletions.filter((c) => c.practice_id === p.id).length
      return {
        ...p,
        completions_this_period: inPeriod,
        remaining_this_period: remainingThisPeriod(p, today, allCompletions),
      }
    })

  const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', timeZone: 'UTC',
  })

  const windowsMap = new Map<string, BlackoutWindow[]>()
  for (const w of blackoutsRow.rows as (BlackoutWindow & { attendance_id: string })[]) {
    const list = windowsMap.get(w.attendance_id) ?? []
    list.push(w)
    windowsMap.set(w.attendance_id, list)
  }
  const attendancesToday = (attendancesRow.rows as AttendanceRow[]).flatMap((att) =>
    expandAndSuppress(att, windowsMap.get(att.id) ?? [], today, today),
  )

  // obligations_today are actionable commitments (treat like timed events for
  // clash detection); attendances_today remain indicative context (excluded
  // from conflict checks, like reminders).
  // "Follow the child": project each obligation onto its MEMBER'S winning
  // instance for today — not necessarily the attendance it was derived from.
  // So when a bounded camp beats the open-ended school for that member/day,
  // the school-derived drop/pick re-project onto the camp instance.
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
  const obligationsToday = (obligationsRow.rows as (ObligationRow & { member_id: string })[])
    .flatMap((ob) => {
      const winner = winnerByMember.get(ob.member_id)
      if (!winner) return []
      const resolved = projectObligation(ob as ObligationRow, winner)
      return resolved ? [resolved] : []
    })
    .filter((r) => r.date === today)

  return {
    date: today,
    weekday,
    user: userRow.rows[0] ?? { id },
    circle: circleRow.rows,
    primary_circle_users: primaryCircleUsersRow.rows,
    events_today: eventsTodayRow.rows,
    events_tomorrow: eventsTomorrowRow.rows,
    recent_past_events: recentPastRow.rows,
    practices_due_today: practicesDue,
    locations: locationsRow.rows,
    attendances_today: attendancesToday,
    obligations_today: obligationsToday,
  }
}

const saveDailyBriefing: ToolHandler = async (args, ctx) => {
  const typedArgs = args as {
    briefing_date: string
    content_md: string
    summary?: string | null
    source: 'claude_code' | 'claude_desktop' | 'web' | 'cron'
  }
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.daily_briefings
       (user_id, briefing_date, content_md, summary, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, briefing_date) DO UPDATE
       SET content_md = EXCLUDED.content_md,
           summary = EXCLUDED.summary,
           source = EXCLUDED.source,
           generated_at = now()
     RETURNING *`,
    [ctx.userId, typedArgs.briefing_date, typedArgs.content_md, typedArgs.summary ?? null, typedArgs.source],
  )
  return rows[0]
}

const getDailyBriefing: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { date?: string }
  const date = typedArgs.date ?? new Date().toISOString().slice(0, 10)
  const { rows } = await ctx.client.query(
    `SELECT id, briefing_date::text, content_md, summary, source, generated_at
     FROM plannen.daily_briefings
     WHERE user_id = $1 AND briefing_date = $2::date`,
    [ctx.userId, date],
  )
  return rows[0] ?? null
}

// ── Module ────────────────────────────────────────────────────────────────────

export const briefingsModule: ToolModule = {
  definitions,
  dispatch: {
    get_briefing_context: getBriefingContext,
    save_daily_briefing: saveDailyBriefing,
    get_daily_briefing: getDailyBriefing,
  },
}
