import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1818-1830) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_relationships',
    description: 'List your family and friends in Plannen',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['family', 'friend', 'all'],
          description: 'Filter by relationship type (default all)',
        },
      },
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

const listRelationships: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const types =
    args.type === 'family' ? ['family', 'both']
    : args.type === 'friend' ? ['friend', 'both']
    : ['family', 'friend', 'both']
  const { rows: rels } = await ctx.client.query(
    `SELECT user_id, related_user_id, relationship_type
     FROM plannen.relationships
     WHERE (user_id = $1 OR related_user_id = $1)
       AND status = 'accepted'
       AND relationship_type = ANY($2)`,
    [id, types],
  )
  const relList = rels as Array<{ user_id: string; related_user_id: string; relationship_type: string }>
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
      relationship_type: r.relationship_type,
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
