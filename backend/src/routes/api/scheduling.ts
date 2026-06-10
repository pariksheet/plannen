import { Hono } from 'hono'
import { withUserContext } from '../../db.js'
import type { AppVariables } from '../../types.js'

// Read-only raw scheduling rows for the web's client-side projection
// (src/utils/scheduling.ts mirrors the pure engine; the browser fetches these
// RLS-scoped rows and runs expand/suppress/override/projection itself).
export const scheduling = new Hono<{ Variables: AppVariables }>()

scheduling.get('/attendances', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT id, user_id, family_member_id, name, location_id, recurrence_rule,
              dtstart::text, recurrence_until::text, time_of_day, start_time, end_time,
              priority, active
       FROM plannen.attendances
       WHERE user_id = $1 AND active = true`,
      [userId],
    )
    return c.json({ data: rows })
  })
})

scheduling.get('/blackout-windows', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT ab.attendance_id, w.calendar_id, w.starts_on::text AS starts_on,
              w.ends_on::text AS ends_on, w.label
       FROM plannen.attendance_blackouts ab
       JOIN plannen.blackout_windows w ON w.calendar_id = ab.calendar_id
       WHERE ab.user_id = $1`,
      [userId],
    )
    return c.json({ data: rows })
  })
})

scheduling.get('/obligations', async (c) => {
  const userId = c.var.userId
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
              o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
       FROM plannen.obligations o
       JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
       WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
      [userId],
    )
    return c.json({ data: rows })
  })
})
