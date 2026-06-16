import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// SQL boolean: is checklist <idCol> accessible to <userParam>? Both MCP servers
// bypass RLS, so access is enforced here, mirroring mcp/src/checklists.ts.
function accessibleChecklistSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc
            WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu
               WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg
               JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
               WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

const definitions: ToolDefinition[] = [
  {
    name: 'create_checklist',
    description: 'Create a lean checklist (packing/shopping/etc). NOT todos — items never appear in the agenda/briefing/list_events. Optionally pass items to fill it in one shot, and event_id to attach it to any event (e.g. a trip).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        event_id: { type: ['string', 'null'], description: 'Container event id to attach to (optional).' },
        items: { type: 'array', items: { type: 'string' }, description: 'Initial item texts, in order.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_checklist_items',
    description: 'Append items to an existing checklist. Allowed for anyone the list is shared with.',
    inputSchema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['checklist_id', 'items'],
    },
  },
  {
    name: 'list_checklists',
    description: 'List checklists you own or that are shared with you, each with {done,total} progress. Optional event_id filters to one trip.',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: ['string', 'null'] } },
    },
  },
  {
    name: 'get_checklist',
    description: 'Get one checklist with its items (ordered) and each item\'s checked_at/checked_by.',
    inputSchema: {
      type: 'object',
      properties: { checklist_id: { type: 'string' } },
      required: ['checklist_id'],
    },
  },
  {
    name: 'check_checklist_item',
    description: 'Tick a checklist item (stamps checked_at + checked_by = you).',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'uncheck_checklist_item',
    description: 'Untick a checklist item (clears checked_at + checked_by).',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'update_checklist_item',
    description: 'Edit a checklist item\'s text.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' }, text: { type: 'string' } },
      required: ['item_id', 'text'],
    },
  },
  {
    name: 'delete_checklist_item',
    description: 'Delete a single checklist item.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'share_checklist',
    description: 'Share a checklist with users and/or friend groups (owner only). Empty arrays are a no-op, never a clear.',
    inputSchema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string' },
        user_ids: { type: 'array', items: { type: 'string' } },
        group_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['checklist_id'],
    },
  },
  {
    name: 'delete_checklist',
    description: 'Delete a checklist and all its items (owner only).',
    inputSchema: {
      type: 'object',
      properties: { checklist_id: { type: 'string' } },
      required: ['checklist_id'],
    },
  },
]

const createChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { title: string; event_id?: string | null; items?: string[] }
  if (a.event_id) {
    const { rows: ev } = await ctx.client.query(
      `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2`,
      [a.event_id, ctx.userId],
    )
    if (ev.length === 0) throw new Error('event_id must be an event you own')
  }
  const { rows: cl } = await ctx.client.query(
    `INSERT INTO plannen.checklists (title, event_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [a.title, a.event_id ?? null, ctx.userId],
  )
  const checklist = cl[0]
  const items = (a.items ?? []).filter((t) => t.trim().length > 0)
  let createdItems: unknown[] = []
  if (items.length > 0) {
    const values = items.map((_, i) => `($1, $${i + 2}, ${i})`).join(', ')
    const { rows } = await ctx.client.query(
      `INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`,
      [checklist.id, ...items],
    )
    createdItems = rows
  }
  return { ...checklist, items: createdItems }
}

const addChecklistItems: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string; items: string[] }
  const { rows: ok } = await ctx.client.query(
    `SELECT 1 WHERE ${accessibleChecklistSql('$1', '$2')}`, [a.checklist_id, ctx.userId])
  if (ok.length === 0) throw new Error('checklist not found or not shared with you')
  const { rows: existing } = await ctx.client.query(
    `SELECT position FROM plannen.checklist_items WHERE checklist_id = $1`, [a.checklist_id])
  const start = existing.length === 0 ? 0 : Math.max(...existing.map((r: { position: number }) => r.position)) + 1
  const items = a.items.filter((t) => t.trim().length > 0)
  if (items.length === 0) return []
  const values = items.map((_, i) => `($1, $${i + 2}, ${start + i})`).join(', ')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.checklist_items (checklist_id, text, position) VALUES ${values} RETURNING *`,
    [a.checklist_id, ...items])
  return rows
}

const listChecklists: ToolHandler = async (args, ctx) => {
  const a = args as { event_id?: string | null }
  const params: unknown[] = [ctx.userId]
  let where = accessibleChecklistSql('cl.id', '$1')
  if (a.event_id) { params.push(a.event_id); where += ` AND cl.event_id = $${params.length}` }
  const { rows } = await ctx.client.query(
    `SELECT cl.*, COALESCE(i.total,0) AS total, COALESCE(i.done,0) AS done
       FROM plannen.checklists cl
       LEFT JOIN (SELECT checklist_id, count(*) AS total, count(checked_at) AS done
                    FROM plannen.checklist_items GROUP BY checklist_id) i ON i.checklist_id = cl.id
      WHERE ${where} ORDER BY cl.created_at DESC`, params)
  return rows
}

const getChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string }
  const { rows: cl } = await ctx.client.query(
    `SELECT * FROM plannen.checklists cl WHERE cl.id = $1 AND ${accessibleChecklistSql('cl.id', '$2')}`,
    [a.checklist_id, ctx.userId])
  if (cl.length === 0) throw new Error('checklist not found or not shared with you')
  const { rows: items } = await ctx.client.query(
    `SELECT * FROM plannen.checklist_items WHERE checklist_id = $1 ORDER BY position ASC, created_at ASC`,
    [a.checklist_id])
  return { ...cl[0], items }
}

async function setItemChecked(ctx: { client: { query: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }> } }, userId: string, itemId: string, checked: boolean) {
  const { rows } = await ctx.client.query(
    `UPDATE plannen.checklist_items it
        SET checked_at = ${checked ? 'now()' : 'NULL'}, checked_by = ${checked ? '$2' : 'NULL'}
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING *`,
    [itemId, userId])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return rows[0]
}

const checkItem: ToolHandler = (args, ctx) => setItemChecked(ctx, ctx.userId, (args as { item_id: string }).item_id, true)
const uncheckItem: ToolHandler = (args, ctx) => setItemChecked(ctx, ctx.userId, (args as { item_id: string }).item_id, false)

const updateItem: ToolHandler = async (args, ctx) => {
  const a = args as { item_id: string; text: string }
  const { rows } = await ctx.client.query(
    `UPDATE plannen.checklist_items it SET text = $3
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING *`,
    [a.item_id, ctx.userId, a.text])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return rows[0]
}

const deleteItem: ToolHandler = async (args, ctx) => {
  const a = args as { item_id: string }
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.checklist_items it
      WHERE it.id = $1 AND ${accessibleChecklistSql('it.checklist_id', '$2')} RETURNING id`,
    [a.item_id, ctx.userId])
  if (rows.length === 0) throw new Error('item not found or not shared with you')
  return { deleted: (rows[0] as { id: string }).id }
}

const shareChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string; user_ids?: string[]; group_ids?: string[] }
  const { rows: own } = await ctx.client.query(
    `SELECT 1 FROM plannen.checklists WHERE id = $1 AND created_by = $2`, [a.checklist_id, ctx.userId])
  if (own.length === 0) throw new Error('only the owner can share a checklist')
  for (const u of a.user_ids ?? [])
    await ctx.client.query(`INSERT INTO plannen.checklist_shared_with_users (checklist_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.checklist_id, u])
  for (const g of a.group_ids ?? [])
    await ctx.client.query(`INSERT INTO plannen.checklist_shared_with_groups (checklist_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.checklist_id, g])
  return { shared: true }
}

const deleteChecklist: ToolHandler = async (args, ctx) => {
  const a = args as { checklist_id: string }
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.checklists WHERE id = $1 AND created_by = $2 RETURNING id`, [a.checklist_id, ctx.userId])
  if (rows.length === 0) throw new Error('checklist not found or you are not the owner')
  return { deleted: (rows[0] as { id: string }).id }
}

export const checklistsModule: ToolModule = {
  definitions,
  dispatch: {
    create_checklist: createChecklist,
    add_checklist_items: addChecklistItems,
    list_checklists: listChecklists,
    get_checklist: getChecklist,
    check_checklist_item: checkItem,
    uncheck_checklist_item: uncheckItem,
    update_checklist_item: updateItem,
    delete_checklist_item: deleteItem,
    share_checklist: shareChecklist,
    delete_checklist: deleteChecklist,
  },
}
