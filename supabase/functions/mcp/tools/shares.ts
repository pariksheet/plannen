import type { PoolClient } from 'npm:pg@8'
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// Unified event sharing. One event_shares row per (event, target). Both MCP
// servers bypass RLS, so ownership/access is enforced here in SQL — mirrors
// mcp/src/index.ts share handlers. Keep the two byte-compatible.

type ShareTarget = { type: 'user' | 'group' | 'all'; id?: string | null }

function normaliseTargets(raw: unknown): ShareTarget[] {
  if (!Array.isArray(raw)) return []
  const out: ShareTarget[] = []
  for (const t of raw) {
    const tt = (t as ShareTarget)?.type
    if (tt !== 'user' && tt !== 'group' && tt !== 'all') continue
    const id = tt === 'all' ? null : ((t as ShareTarget).id ?? null)
    if (tt !== 'all' && !id) continue
    out.push({ type: tt, id })
  }
  return out
}

/** Owner-only: insert event_shares rows for an event at the given level. */
async function writeShares(
  client: PoolClient, userId: string, eventId: string,
  targets: ShareTarget[], level: 'awareness' | 'assigned',
  requireKind?: string,
): Promise<number> {
  const { rows: own } = await client.query(
    `SELECT event_kind FROM plannen.events WHERE id = $1 AND created_by = $2`,
    [eventId, userId],
  )
  if (own.length === 0) throw new Error('event not found or you are not the owner')
  if (requireKind && own[0].event_kind !== requireKind) {
    throw new Error(`this action requires an event_kind='${requireKind}'`)
  }
  let n = 0
  for (const t of targets) {
    await client.query(
      `INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, target_type, target_id)
       DO UPDATE SET level = EXCLUDED.level`,
      [eventId, t.type, t.id, level, userId],
    )
    n++
  }
  return n
}

/**
 * Write an explicit `share` list (as passed to create_event) at awareness
 * level. Shared with the create_event handler so the contract stays in one
 * place. Owner check happens inside writeShares.
 */
export async function writeShareTargets(
  client: PoolClient, userId: string, eventId: string, share: unknown,
): Promise<void> {
  const targets = normaliseTargets(share)
  if (targets.length === 0) return
  await writeShares(client, userId, eventId, targets, 'awareness')
}

/**
 * Apply the caller's default-share rule to a just-created event. Called from
 * create_event when no explicit `share` was supplied. No-op unless
 * default_share_enabled. Shared so both create paths behave identically.
 */
export async function applyDefaultShare(client: PoolClient, userId: string, eventId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT default_share_enabled, default_share_target_type, default_share_target_id, default_share_level
       FROM plannen.user_settings WHERE user_id = $1`,
    [userId],
  )
  const s = rows[0]
  if (!s || !s.default_share_enabled || !s.default_share_target_type) return
  await client.query(
    `INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id, target_type, target_id) DO NOTHING`,
    [eventId, s.default_share_target_type, s.default_share_target_id ?? null, s.default_share_level ?? 'awareness', userId],
  )
}

const definitions: ToolDefinition[] = [
  {
    name: 'share_event',
    description: 'Share an event/reminder/trip with people and/or groups at read-only "awareness" level (the default). Recipients see it in their "Shared with me" inbox and opt in to put it on their own agenda; it never blocks their calendar. Owner only. Sharing a container/trip surfaces its child events too. Empty targets is a no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        targets: {
          type: 'array',
          description: 'Who to share with. Each: {type:"user"|"group"|"all", id?} — id is a user UUID or friend_group UUID; omit id for type "all" (all accepted connections).',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['user', 'group', 'all'] }, id: { type: ['string', 'null'] } },
            required: ['type'],
          },
        },
        level: { type: 'string', enum: ['awareness', 'assigned'], description: 'Defaults to awareness. Use assign_todo for assignment instead.' },
      },
      required: ['event_id', 'targets'],
    },
  },
  {
    name: 'assign_todo',
    description: 'Assign a todo to people/groups so they can complete it (co-ownership: it appears in their list AND yours, and whoever finishes marks it done for both). Owner only; the event must be a todo. Shares at "assigned" level — recipients get write access to completion via complete_event.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string' },
        targets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['user', 'group'] }, id: { type: 'string' } },
            required: ['type', 'id'],
          },
        },
      },
      required: ['todo_id', 'targets'],
    },
  },
  {
    name: 'unshare_event',
    description: 'Remove one share from an event (owner only). Pass target_type and target_id (omit target_id for type "all").',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        target_type: { type: 'string', enum: ['user', 'group', 'all'] },
        target_id: { type: ['string', 'null'] },
      },
      required: ['event_id', 'target_type'],
    },
  },
  {
    name: 'adopt_shared_event',
    description: 'Pull an awareness-shared event onto your own agenda (the opt-in step). Until adopted it sits in your "Shared with me" inbox. You must be able to see the event.',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },
  {
    name: 'unadopt_shared_event',
    description: 'Remove a previously-adopted shared event from your agenda (back to the inbox). Does not unshare it.',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },
  {
    name: 'complete_event',
    description: 'Mark an event/todo complete (or pass done:false to reopen). Allowed for the creator OR anyone it was assigned to via assign_todo. Use this instead of update_event for assigned todos.',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' }, done: { type: 'boolean', description: 'Defaults true; false reopens.' } },
      required: ['event_id'],
    },
  },
]

const shareEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string; targets: unknown; level?: 'awareness' | 'assigned' }
  const targets = normaliseTargets(a.targets)
  if (targets.length === 0) return { shared: 0 }
  const n = await writeShares(ctx.client, ctx.userId, a.event_id, targets, a.level === 'assigned' ? 'assigned' : 'awareness')
  return { shared: n }
}

const assignTodo: ToolHandler = async (args, ctx) => {
  const a = args as { todo_id: string; targets: unknown }
  const targets = normaliseTargets(a.targets).filter((t) => t.type !== 'all')
  if (targets.length === 0) throw new Error('assign_todo needs at least one user or group target')
  const n = await writeShares(ctx.client, ctx.userId, a.todo_id, targets, 'assigned', 'todo')
  return { assigned: n }
}

const unshareEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string; target_type: 'user' | 'group' | 'all'; target_id?: string | null }
  const { rows: own } = await ctx.client.query(
    `SELECT 1 FROM plannen.events WHERE id = $1 AND created_by = $2`, [a.event_id, ctx.userId])
  if (own.length === 0) throw new Error('event not found or you are not the owner')
  const idClause = a.target_type === 'all' ? 'target_id IS NULL' : 'target_id = $3'
  const params: unknown[] = a.target_type === 'all' ? [a.event_id, a.target_type] : [a.event_id, a.target_type, a.target_id]
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.event_shares WHERE event_id = $1 AND target_type = $2 AND ${idClause} RETURNING id`, params)
  return { removed: rows.length }
}

const adoptSharedEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string }
  const { rows: ok } = await ctx.client.query(
    `SELECT 1 FROM plannen.events e
      WHERE e.id = $1 AND (e.created_by = $2 OR plannen.user_can_see_event(e.id))`,
    [a.event_id, ctx.userId])
  if (ok.length === 0) throw new Error('event not found or not shared with you')
  await ctx.client.query(
    `INSERT INTO plannen.event_share_adoption (event_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`, [a.event_id, ctx.userId])
  return { adopted: true }
}

const unadoptSharedEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string }
  const { rows } = await ctx.client.query(
    `DELETE FROM plannen.event_share_adoption WHERE event_id = $1 AND user_id = $2 RETURNING event_id`,
    [a.event_id, ctx.userId])
  return { adopted: false, removed: rows.length }
}

const completeEvent: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string; done?: boolean }
  const { rows } = await ctx.client.query(
    `SELECT * FROM plannen.complete_event($1, $2)`, [a.event_id, a.done !== false])
  if (rows.length === 0) throw new Error('event not found')
  return rows[0]
}

export const sharesModule: ToolModule = {
  definitions,
  dispatch: {
    share_event: shareEvent,
    assign_todo: assignTodo,
    unshare_event: unshareEvent,
    adopt_shared_event: adoptSharedEvent,
    unadopt_shared_event: unadoptSharedEvent,
    complete_event: completeEvent,
  },
}
