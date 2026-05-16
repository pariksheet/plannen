import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1832-1871) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'get_profile_context',
    description:
      "Return the user's profile context: saved locations, interests, goals, offline family members (with IDs for use as upsert_profile_fact subjects), and all current profile_facts (confidence≥0.6). Call this at the start of every session to prime context, and when the user's query references personal context like \"my son\", \"near home\". Pass include_historical=true to also return past facts with a \"used to\" meaning.",
    inputSchema: {
      type: 'object',
      properties: {
        include_historical: { type: 'boolean', description: 'Also return historical (corrected/contradicted) facts' },
      },
    },
  },
  {
    name: 'update_profile',
    description: "Save or update the user's profile: date of birth, personal goals, interests, and timezone. Infer timezone from the user's city/country (e.g. Mechelen, Belgium → Europe/Brussels) and confirm before saving.",
    inputSchema: {
      type: 'object',
      properties: {
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD, or null to clear' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Free-text personal goals (replaces existing list)' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Free-text interest tags (replaces existing list)' },
        timezone: { type: 'string', description: 'IANA timezone, e.g. "Europe/Brussels", "Australia/Sydney", "America/New_York". Derive from city/country and confirm with user.' },
      },
      required: [],
    },
  },
  {
    name: 'get_story_languages',
    description: 'Return the user\'s configured story languages from user_profiles.story_languages. Order matters — the first entry is the canonical language used for the initial composition; subsequent entries are translations. Always returns at least one language ("en" default).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_story_languages',
    description: 'Set the user\'s configured story languages (1–3, ordered, codes from: en, nl, fr, de, es, it, pt, hi, mr, ja, zh, ar). Order is preserved; the first entry is canonical.',
    inputSchema: {
      type: 'object',
      properties: {
        languages: { type: 'array', items: { type: 'string' } },
      },
      required: ['languages'],
    },
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  if (isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) return age - 1
  return age
}

const ALLOWED_LANG_CODES = new Set(['en', 'nl', 'fr', 'de', 'es', 'it', 'pt', 'hi', 'mr', 'ja', 'zh', 'ar'])

// ── Handlers ──────────────────────────────────────────────────────────────────

const getProfileContext: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const typedArgs = args as { include_historical?: boolean }
  const [profileRes, locationsRes, familyRes, factsRes, historicalRes] = await Promise.all([
    ctx.client.query(
      'SELECT dob, goals, interests, timezone FROM plannen.user_profiles WHERE user_id = $1',
      [id],
    ),
    ctx.client.query(
      'SELECT label, city, country, is_default FROM plannen.user_locations WHERE user_id = $1 ORDER BY created_at ASC',
      [id],
    ),
    ctx.client.query(
      'SELECT id, name, relation, dob, gender, goals, interests FROM plannen.family_members WHERE user_id = $1 ORDER BY created_at ASC',
      [id],
    ),
    ctx.client.query(
      `SELECT subject, predicate, value, confidence, source
       FROM plannen.profile_facts
       WHERE user_id = $1 AND is_historical = false AND confidence >= 0.6
       ORDER BY subject ASC, predicate ASC`,
      [id],
    ),
    typedArgs.include_historical
      ? ctx.client.query(
          `SELECT subject, predicate, value, confidence
           FROM plannen.profile_facts
           WHERE user_id = $1 AND is_historical = true
           ORDER BY subject ASC, last_seen_at DESC`,
          [id],
        )
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
  ])
  const profile = profileRes.rows[0] as
    | { dob: string | null; goals: string[]; interests: string[]; timezone: string }
    | undefined
  type FamilyRow = {
    id: string
    name: string
    relation: string
    dob: string | null
    gender: string | null
    goals: string[]
    interests: string[]
  }
  type LocationRow = { label: string; city: string; country: string; is_default: boolean }
  return {
    goals: profile?.goals ?? [],
    interests: profile?.interests ?? [],
    timezone: profile?.timezone ?? 'UTC',
    locations: (locationsRes.rows as LocationRow[]).map((l) => ({
      label: l.label,
      city: l.city,
      country: l.country,
      is_default: l.is_default,
    })),
    family_members: (familyRes.rows as FamilyRow[]).map((m) => ({
      id: m.id,
      name: m.name,
      relation: m.relation,
      age: computeAge(m.dob),
      gender: m.gender,
      goals: m.goals,
      interests: m.interests,
    })),
    profile_facts: factsRes.rows,
    historical_facts: typedArgs.include_historical ? historicalRes.rows : undefined,
  }
}

const updateProfile: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const typedArgs = args as {
    dob?: string | null
    goals?: string[]
    interests?: string[]
    timezone?: string
  }
  const cols: string[] = ['user_id']
  const vals: unknown[] = [id]
  const sets: string[] = []
  if (typedArgs.dob !== undefined) {
    cols.push('dob'); vals.push(typedArgs.dob); sets.push(`dob = $${vals.length}`)
  }
  if (typedArgs.goals !== undefined) {
    cols.push('goals'); vals.push(typedArgs.goals); sets.push(`goals = $${vals.length}`)
  }
  if (typedArgs.interests !== undefined) {
    cols.push('interests'); vals.push(typedArgs.interests); sets.push(`interests = $${vals.length}`)
  }
  if (typedArgs.timezone !== undefined) {
    cols.push('timezone'); vals.push(typedArgs.timezone); sets.push(`timezone = $${vals.length}`)
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
  const updateClause = sets.length > 0
    ? `DO UPDATE SET ${sets.join(', ')}`
    : 'DO NOTHING'
  await ctx.client.query(
    `INSERT INTO plannen.user_profiles (${cols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (user_id) ${updateClause}`,
    vals,
  )
  return { success: true }
}

const getStoryLanguages: ToolHandler = async (_args, ctx) => {
  const id = ctx.userId
  const { rows } = await ctx.client.query(
    'SELECT story_languages FROM plannen.user_profiles WHERE user_id = $1',
    [id],
  )
  const langs = (rows[0]?.story_languages as string[] | null | undefined) ?? ['en']
  return { languages: langs.length ? langs : ['en'] }
}

const setStoryLanguages: ToolHandler = async (args, ctx) => {
  const id = ctx.userId
  const typedArgs = args as { languages: string[] }
  if (!Array.isArray(typedArgs.languages) || typedArgs.languages.length === 0) {
    throw new Error('languages must be a non-empty array')
  }
  if (typedArgs.languages.length > 3) throw new Error('Maximum 3 languages.')
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const code of typedArgs.languages) {
    if (!ALLOWED_LANG_CODES.has(code)) throw new Error(`Unknown language: ${code}`)
    if (!seen.has(code)) { seen.add(code); cleaned.push(code) }
  }
  await ctx.client.query(
    `INSERT INTO plannen.user_profiles (user_id, story_languages)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET story_languages = EXCLUDED.story_languages`,
    [id, cleaned],
  )
  return { languages: cleaned }
}

// ── Module ────────────────────────────────────────────────────────────────────

export const profileModule: ToolModule = {
  definitions,
  dispatch: {
    get_profile_context: getProfileContext,
    update_profile: updateProfile,
    get_story_languages: getStoryLanguages,
    set_story_languages: setStoryLanguages,
  },
}
