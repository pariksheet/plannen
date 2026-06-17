import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const checklists = new Hono<{ Variables: AppVariables }>()

function accessibleSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

const CreateInput = z.object({ title: z.string().min(1), event_id: z.string().uuid().nullish(), items: z.array(z.string()).optional() })
const UpdateInput = z.object({ title: z.string().min(1).optional(), event_id: z.string().uuid().nullish() })
  .refine((v) => v.title !== undefined || 'event_id' in v, 'nothing to update')
const ItemsInput = z.object({ items: z.array(z.string()) })
const CheckedInput = z.object({ checked: z.boolean() })
const TextInput = z.object({ text: z.string().min(1) })
const ShareInput = z.object({ user_ids: z.array(z.string().uuid()).optional(), group_ids: z.array(z.string().uuid()).optional() })

// ── Item routes (specific — registered BEFORE the generic /:id routes) ─────────

checklists.patch('/items/:itemId/checked', async (c) => {
  const userId = c.var.userId
  const itemId = c.req.param('itemId')
  const parsed = CheckedInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'checked:boolean required')
  const checked = parsed.data.checked
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.checklist_items it SET checked_at = ${checked ? 'now()' : 'NULL'}, checked_by = ${checked ? '$2' : 'NULL'}
        WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')} RETURNING *`,
      [itemId, userId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.json({ data: rows[0] })
  })
})

checklists.patch('/items/:itemId', async (c) => {
  const userId = c.var.userId
  const itemId = c.req.param('itemId')
  const parsed = TextInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'text required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `UPDATE plannen.checklist_items it SET text = $3 WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')} RETURNING *`,
      [itemId, userId, parsed.data.text],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.json({ data: rows[0] })
  })
})

checklists.delete('/items/:itemId', async (c) => {
  const userId = c.var.userId
  const itemId = c.req.param('itemId')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      `DELETE FROM plannen.checklist_items it WHERE it.id = $1 AND ${accessibleSql('it.checklist_id', '$2')}`,
      [itemId, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'item not found')
    return c.body(null, 204)
  })
})

// ── Checklist routes ───────────────────────────────────────────────────────────

checklists.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let where = accessibleSql('cl.id', '$1')
    if (eventId) {
      params.push(eventId)
      where += ` AND cl.event_id = $${params.length}`
    }
    const { rows } = await db.query(
      `SELECT cl.*, COALESCE(i.total,0) AS total, COALESCE(i.done,0) AS done
         FROM plannen.checklists cl
         LEFT JOIN (SELECT checklist_id, count(*) AS total, count(checked_at) AS done FROM plannen.checklist_items GROUP BY checklist_id) i ON i.checklist_id = cl.id
        WHERE ${where} ORDER BY cl.created_at DESC`,
      params,
    )
    return c.json({ data: rows })
  })
})

checklists.get('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rows: cl } = await db.query(
      `SELECT * FROM plannen.checklists cl WHERE cl.id = $1 AND ${accessibleSql('cl.id', '$2')}`,
      [id, userId],
    )
    if (cl.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    const { rows: items } = await db.query(
      `SELECT * FROM plannen.checklist_items WHERE checklist_id = $1 ORDER BY position ASC, created_at ASC`,
      [id],
    )
    return c.json({ data: { ...cl[0], items } })
  })
})

checklists.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = CreateInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid checklist', JSON.stringify(parsed.error.issues))
  const p = parsed.data
  return await withUserContext(userId, async (db) => {
    if (p.event_id) {
      const { rows: ev } = await db.query(
        `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2`,
        [p.event_id, userId],
      )
      if (ev.length === 0) throw new HttpError(400, 'VALIDATION', 'event_id must be an event you own')
    }
    const { rows: cl } = await db.query(
      `INSERT INTO plannen.checklists (title, event_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [p.title, p.event_id ?? null, userId],
    )
    const texts = (p.items ?? []).filter((t) => t.trim().length > 0)
    let items: unknown[] = []
    if (texts.length) {
      const byParam = texts.length + 2
      const values = texts.map((_, i) => `($1, $${i + 2}, ${i}, $${byParam})`).join(', ')
      items = (
        await db.query(
          `INSERT INTO plannen.checklist_items (checklist_id, text, position, created_by) VALUES ${values} RETURNING *`,
          [cl[0].id, ...texts, userId],
        )
      ).rows
    }
    return c.json({ data: { ...cl[0], items } }, 201)
  })
})

checklists.patch('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const raw = await c.req.json() as Record<string, unknown>
  const parsed = UpdateInput.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'title or event_id required')
  const setEvent = 'event_id' in raw
  return await withUserContext(userId, async (db) => {
    if (setEvent && parsed.data.event_id) {
      const { rows: ev } = await db.query(
        `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2`,
        [parsed.data.event_id, userId],
      )
      if (ev.length === 0) throw new HttpError(400, 'VALIDATION', 'event_id must be an event you own')
    }
    const sets: string[] = []
    const vals: unknown[] = [id, userId]
    if (parsed.data.title !== undefined) { vals.push(parsed.data.title); sets.push(`title = $${vals.length}`) }
    if (setEvent) { vals.push(parsed.data.event_id ?? null); sets.push(`event_id = $${vals.length}`) }
    const { rows } = await db.query(
      `UPDATE plannen.checklists SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND created_by = $2 RETURNING *`,
      vals,
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    return c.json({ data: rows[0] })
  })
})

checklists.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      `DELETE FROM plannen.checklists WHERE id = $1 AND created_by = $2`,
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    return c.body(null, 204)
  })
})

checklists.post('/:id/items', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = ItemsInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid items')
  return await withUserContext(userId, async (db) => {
    const { rows: ok } = await db.query(
      `SELECT 1 WHERE ${accessibleSql('$1', '$2')}`,
      [id, userId],
    )
    if (ok.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    const { rows: existing } = await db.query(
      `SELECT position FROM plannen.checklist_items WHERE checklist_id = $1`,
      [id],
    )
    const start =
      existing.length === 0 ? 0 : Math.max(...existing.map((r: { position: number }) => r.position)) + 1
    const texts = parsed.data.items.filter((t) => t.trim().length > 0)
    if (!texts.length) return c.json({ data: [] })
    const byParam = texts.length + 2
    const values = texts.map((_, i) => `($1, $${i + 2}, ${start + i}, $${byParam})`).join(', ')
    const { rows } = await db.query(
      `INSERT INTO plannen.checklist_items (checklist_id, text, position, created_by) VALUES ${values} RETURNING *`,
      [id, ...texts, userId],
    )
    return c.json({ data: rows }, 201)
  })
})

checklists.post('/:id/shares', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  const parsed = ShareInput.safeParse(await c.req.json())
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid share input')
  return await withUserContext(userId, async (db) => {
    const { rows: own } = await db.query(
      `SELECT 1 FROM plannen.checklists WHERE id = $1 AND created_by = $2`,
      [id, userId],
    )
    if (own.length === 0) throw new HttpError(404, 'NOT_FOUND', 'checklist not found')
    for (const u of parsed.data.user_ids ?? [])
      await db.query(
        `INSERT INTO plannen.checklist_shared_with_users (checklist_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, u],
      )
    for (const g of parsed.data.group_ids ?? [])
      await db.query(
        `INSERT INTO plannen.checklist_shared_with_groups (checklist_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, g],
      )
    return c.json({ data: { shared: true } })
  })
})
