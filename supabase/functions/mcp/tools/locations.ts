import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1894-1912) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'add_location',
    description: "Add a named location (e.g. Home, Work) to the user's saved locations.",
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'e.g. "Home", "Work"' },
        address: { type: 'string', description: 'Full address string' },
        city: { type: 'string' },
        country: { type: 'string' },
        is_default: { type: 'boolean', description: 'Set as default location for searches (clears any existing default)' },
      },
      required: ['label'],
    },
  },
  {
    name: 'list_locations',
    description: "List the user's saved locations.",
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

const addLocation: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  if (args.is_default) {
    await ctx.client.query(
      'UPDATE plannen.user_locations SET is_default = false WHERE user_id = $1',
      [id],
    )
  }
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.user_locations (user_id, label, address, city, country, is_default)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      id,
      args.label,
      args.address ?? '',
      args.city ?? '',
      args.country ?? '',
      args.is_default ?? false,
    ],
  )
  if (rows.length === 0) throw new Error('Insert failed')
  return rows[0]
}

const listLocations: ToolHandler = async (_args, ctx) => {
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `SELECT id, label, address, city, country, is_default
     FROM plannen.user_locations
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [id],
  )
  return rows
}

// ── Module ────────────────────────────────────────────────────────────────────

export const locationsModule: ToolModule = {
  definitions,
  dispatch: {
    add_location: addLocation,
    list_locations: listLocations,
  },
}
