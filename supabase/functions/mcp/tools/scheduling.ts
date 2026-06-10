import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2774-2895) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'create_attendance',
    description: 'Record that a family member attends a place on a recurring schedule (school, creche, camp). Indicative context only — never auto-actioned and excluded from conflict checks. Drop/pick are separate linked obligations (create_obligation).',
    inputSchema: {
      type: 'object',
      properties: {
        family_member_id: { type: 'string' },
        name: { type: 'string' },
        location_id: { type: ['string', 'null'] },
        recurrence_rule: { type: 'object',
          description: "{ frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }. Examples: every other day = {frequency:'daily',interval:2}; weekdays = {frequency:'weekly',days:['MO','TU','WE','TH','FR']}; monthly = {frequency:'monthly'}.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string' },
        recurrence_until: { type: 'string', description: 'NULL/omitted = open-ended enrolment like a school term; set a date for a bounded enrolment like a camp week — bounded wins override resolution for its window.' },
        time_of_day: { type: 'string' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_time: { type: 'string', description: 'HH:MM' },
        priority: { type: 'number', description: 'Higher wins member overlap; bounded camps seed higher, e.g. 10.' },
      },
      required: ['family_member_id', 'name', 'recurrence_rule'],
    },
  },
  {
    name: 'update_attendance',
    description: 'Update fields on an existing attendance.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        family_member_id: { type: 'string' },
        name: { type: 'string' },
        location_id: { type: ['string', 'null'] },
        recurrence_rule: { type: 'object',
          description: "{ frequency: 'daily'|'weekly'|'monthly', interval?: number, days?: ['MO','WE','FR'] }.",
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'number', description: 'Repeat every N units (default 1). For daily this is the every-N-days spacing.' },
            days: { type: 'array', items: { type: 'string', enum: ['MO','TU','WE','TH','FR','SA','SU'] }, description: 'Weekday codes; required for weekly.' },
          },
          required: ['frequency'] },
        dtstart: { type: 'string' },
        recurrence_until: { type: 'string', description: 'NULL/omitted = open-ended enrolment like a school term; set a date for a bounded enrolment like a camp week — bounded wins override resolution for its window.' },
        time_of_day: { type: 'string' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_time: { type: 'string', description: 'HH:MM' },
        priority: { type: 'number', description: 'Higher wins member overlap; bounded camps seed higher, e.g. 10.' },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_attendances',
    description: 'List attendances (recurring place enrolments like school, creche, camp). Indicative context only — excluded from conflict checks.',
    inputSchema: {
      type: 'object',
      properties: {
        family_member_id: { type: 'string' },
        active_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_attendance',
    description: 'Soft-delete an attendance (sets active=false).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_blackout_calendar',
    description: "A named set of date-range windows (e.g. 'example school holidays') that suppress linked attendance instances.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        family_member_id: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_blackout_window',
    description: "Add an inclusive date-range window to a blackout calendar. Suppresses linked attendance instances on those dates.",
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        starts_on: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        ends_on: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        label: { type: 'string' },
      },
      required: ['calendar_id', 'starts_on', 'ends_on'],
    },
  },
  {
    name: 'list_blackout_calendars',
    description: 'List your blackout calendars, each with its windows array.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'link_attendance_blackout',
    description: "Link a blackout calendar to an attendance so its windows suppress that attendance's instances.",
    inputSchema: {
      type: 'object',
      properties: {
        attendance_id: { type: 'string' },
        calendar_id: { type: 'string' },
      },
      required: ['attendance_id', 'calendar_id'],
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

type AttendanceInput = {
  family_member_id: string
  name: string
  location_id?: string | null
  recurrence_rule: { frequency: 'daily' | 'weekly' | 'monthly'; interval?: number; days?: string[] }
  dtstart?: string | null
  recurrence_until?: string | null
  time_of_day?: string | null
  start_time?: string | null
  end_time?: string | null
  priority?: number | null
}

const createAttendance: ToolHandler = async (args, ctx) => {
  const a = args as AttendanceInput
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.attendances
       (user_id, family_member_id, name, location_id, recurrence_rule,
        dtstart, recurrence_until, time_of_day, start_time, end_time, priority)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, current_date), $7, $8, $9, $10, COALESCE($11, 0))
     RETURNING *`,
    [
      id,
      a.family_member_id,
      a.name,
      a.location_id ?? null,
      JSON.stringify(a.recurrence_rule),
      a.dtstart ?? null,
      a.recurrence_until ?? null,
      a.time_of_day ?? null,
      a.start_time ?? null,
      a.end_time ?? null,
      a.priority ?? null,
    ],
  )
  return rows[0]
}

const updateAttendance: ToolHandler = async (args, ctx) => {
  const a = args as { id: string } & Partial<AttendanceInput> & { active?: boolean }
  const userId = ctx.userId
  const sets: string[] = []
  const params: unknown[] = []
  const entries = Object.entries(a).filter(([k, v]) => k !== 'id' && v !== undefined)
  for (const [k, v] of entries) {
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (sets.length === 0) throw new Error('no fields to update')
  params.push(a.id, userId)
  const { rows } = await ctx.client.query(
    `UPDATE plannen.attendances SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING *`,
    params,
  )
  if (rows.length === 0) throw new Error('attendance not found')
  return rows[0]
}

const listAttendances: ToolHandler = async (args, ctx) => {
  const a = (args ?? {}) as { family_member_id?: string; active_only?: boolean }
  const id = ctx.userId
  const where: string[] = ['user_id = $1']
  const params: unknown[] = [id]
  if (a.family_member_id !== undefined) {
    params.push(a.family_member_id)
    where.push(`family_member_id = $${params.length}`)
  }
  if (a.active_only) where.push('active = true')
  const { rows } = await ctx.client.query(
    `SELECT id, family_member_id, name, location_id, recurrence_rule,
            dtstart::text, recurrence_until::text, time_of_day, start_time, end_time,
            priority, active, created_at, updated_at
     FROM plannen.attendances
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`,
    params,
  )
  return rows
}

const deleteAttendance: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const userId = ctx.userId
  const { rowCount } = await ctx.client.query(
    `UPDATE plannen.attendances SET active = false
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [a.id, userId],
  )
  if (rowCount === 0) throw new Error('attendance not found')
  return { ok: true }
}

const createBlackoutCalendar: ToolHandler = async (args, ctx) => {
  const a = args as { name: string; family_member_id?: string | null }
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.blackout_calendars (user_id, family_member_id, name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, a.family_member_id ?? null, a.name],
  )
  return rows[0]
}

const addBlackoutWindow: ToolHandler = async (args, ctx) => {
  const a = args as { calendar_id: string; starts_on: string; ends_on: string; label?: string | null }
  const userId = ctx.userId
  const { rows: ownRows } = await ctx.client.query(
    `SELECT 1 FROM plannen.blackout_calendars WHERE id = $1 AND user_id = $2`,
    [a.calendar_id, userId],
  )
  if (ownRows.length === 0) throw new Error('calendar not found')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.blackout_windows (user_id, calendar_id, starts_on, ends_on, label)
     VALUES ($1, $2, $3::date, $4::date, $5)
     RETURNING *`,
    [userId, a.calendar_id, a.starts_on, a.ends_on, a.label ?? null],
  )
  return rows[0]
}

const listBlackoutCalendars: ToolHandler = async (_args, ctx) => {
  const id = ctx.userId
  const { rows: calendars } = await ctx.client.query(
    `SELECT id, family_member_id, name, active, created_at, updated_at
     FROM plannen.blackout_calendars
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [id],
  )
  const { rows: windows } = await ctx.client.query(
    `SELECT id, calendar_id, starts_on::text, ends_on::text, label, created_at
     FROM plannen.blackout_windows
     WHERE user_id = $1
     ORDER BY starts_on ASC`,
    [id],
  )
  const byCalendar = new Map<string, unknown[]>()
  for (const w of windows as Array<{ calendar_id: string }>) {
    const list = byCalendar.get(w.calendar_id) ?? []
    list.push(w)
    byCalendar.set(w.calendar_id, list)
  }
  return (calendars as Array<{ id: string }>).map((cal) => ({
    ...cal,
    windows: byCalendar.get(cal.id) ?? [],
  }))
}

const linkAttendanceBlackout: ToolHandler = async (args, ctx) => {
  const a = args as { attendance_id: string; calendar_id: string }
  const userId = ctx.userId
  const { rows: attRows } = await ctx.client.query(
    `SELECT 1 FROM plannen.attendances WHERE id = $1 AND user_id = $2`,
    [a.attendance_id, userId],
  )
  if (attRows.length === 0) throw new Error('attendance not found')
  const { rows: calRows } = await ctx.client.query(
    `SELECT 1 FROM plannen.blackout_calendars WHERE id = $1 AND user_id = $2`,
    [a.calendar_id, userId],
  )
  if (calRows.length === 0) throw new Error('calendar not found')
  await ctx.client.query(
    `INSERT INTO plannen.attendance_blackouts (attendance_id, calendar_id, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (attendance_id, calendar_id) DO NOTHING`,
    [a.attendance_id, a.calendar_id, userId],
  )
  return { ok: true }
}

// ── Module ────────────────────────────────────────────────────────────────────

export const schedulingModule: ToolModule = {
  definitions,
  dispatch: {
    create_attendance: createAttendance,
    update_attendance: updateAttendance,
    list_attendances: listAttendances,
    delete_attendance: deleteAttendance,
    create_blackout_calendar: createBlackoutCalendar,
    add_blackout_window: addBlackoutWindow,
    list_blackout_calendars: listBlackoutCalendars,
    link_attendance_blackout: linkAttendanceBlackout,
  },
}
