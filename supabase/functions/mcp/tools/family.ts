import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1873-1892) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'add_family_member',
    description: 'Add an offline family member (someone who does not have a Plannen account, e.g. a child).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        relation: { type: 'string', description: 'e.g. "son", "daughter", "mother", "father"' },
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD' },
        gender: { type: ['string', 'null'], description: 'e.g. "male", "female"' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Goals for this family member' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Interests/hobbies for this family member (e.g. "hockey", "swimming")' },
      },
      required: ['name', 'relation'],
    },
  },
  {
    name: 'list_family_members',
    description: 'List all offline family members with their computed ages.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  const today = new Date()
  const age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) return age - 1
  return age
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const addFamilyMember: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.family_members
       (user_id, name, relation, dob, gender, goals, interests)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      args.name,
      args.relation,
      args.dob ?? null,
      args.gender ?? null,
      args.goals ?? [],
      args.interests ?? [],
    ],
  )
  if (rows.length === 0) throw new Error('Insert failed')
  return rows[0]
}

const listFamilyMembers: ToolHandler = async (_args, ctx) => {
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    `SELECT id, name, relation, dob, gender, goals, interests
     FROM plannen.family_members
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [id],
  )
  return (rows as Array<{ id: string; name: string; relation: string; dob: string | null; gender: string | null; goals: string[]; interests: string[] }>)
    .map((m) => ({ ...m, age: computeAge(m.dob) }))
}

// ── Module ────────────────────────────────────────────────────────────────────

export const familyModule: ToolModule = {
  definitions,
  dispatch: {
    add_family_member: addFamilyMember,
    list_family_members: listFamilyMembers,
  },
}
