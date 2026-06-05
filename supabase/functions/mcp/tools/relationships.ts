import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions ──────────────────────────────────────────────────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_relationships',
    description: "List your accepted connections in Plannen (real Plannen users you're connected to).",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

const listRelationships: ToolHandler = async (_args, ctx) => {
  const id = ctx.userId
  const { rows: rels } = await ctx.client.query(
    `SELECT user_id, related_user_id
     FROM plannen.relationships
     WHERE (user_id = $1 OR related_user_id = $1)
       AND status = 'accepted'`,
    [id],
  )
  const relList = rels as Array<{ user_id: string; related_user_id: string }>
  const otherIds = relList.map((r) => r.user_id === id ? r.related_user_id : r.user_id)
  if (!otherIds.length) return []
  const { rows: users } = await ctx.client.query(
    'SELECT id, full_name, email FROM plannen.users WHERE id = ANY($1)',
    [otherIds],
  )
  const userList = users as Array<{ id: string; full_name: string | null; email: string | null }>
  return relList.map((r) => {
    const otherId = r.user_id === id ? r.related_user_id : r.user_id
    const person = userList.find((u) => u.id === otherId)
    return {
      id: otherId,
      full_name: person?.full_name ?? null,
      email: person?.email ?? null,
    }
  })
}

// ── Module ────────────────────────────────────────────────────────────────────

export const relationshipsModule: ToolModule = {
  definitions,
  dispatch: {
    list_relationships: listRelationships,
  },
}
