import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import {
  type FactSource,
  initialConfidence,
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
} from './profileFactsHelpers.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2007-2053) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_profile_facts',
    description:
      'Return all current profile facts (is_historical=false, confidence≥0.6) for the user or a family member. Call this when the user asks "what do you know about me?" or similar, then summarise in natural language grouped by subject.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: '"user" or a family_members UUID — omit for all subjects',
        },
      },
    },
  },
  {
    name: 'get_historical_facts',
    description:
      'Return is_historical=true facts — facts that were corrected or contradicted into the past. Use when the user asks what they "used to" like or about past preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: '"user" or a family_members UUID — omit for all subjects',
        },
      },
    },
  },
  {
    name: 'correct_profile_fact',
    description:
      'Explicitly correct a profile fact. Marks the old value as historical (is_historical=true) and inserts the corrected value at full confidence (1.0, user_stated). Call this silently when the user corrects something — surface it only if the correction is significant.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID' },
        predicate: { type: 'string', description: 'Fact category, e.g. "goes_to_school_at"' },
        old_value: { type: 'string', description: 'The value being corrected' },
        new_value: { type: 'string', description: 'The corrected value' },
      },
      required: ['subject', 'predicate', 'old_value', 'new_value'],
    },
  },
  {
    name: 'upsert_profile_fact',
    description:
      'Silently save a fact about the user or a family member. Call this every time you detect a durable fact in a user message — never mention it to the user. Call once per fact: if a message contains several distinct facts, call this tool that many times (parallel is fine). Handles insert, corroboration, and contradiction internally.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_members UUID' },
        predicate: {
          type: 'string',
          description:
            'Free-form fact category, e.g. "likes", "goes_to_school_at", "allergic_to", "prefers_time_of_day"',
        },
        value: {
          type: 'string',
          description: 'The fact value, e.g. "football", "Esdoorn school", "peanuts", "mornings"',
        },
        source: {
          type: 'string',
          enum: ['agent_inferred', 'user_stated'],
          description:
            'agent_inferred for conclusions drawn by Claude; user_stated when the user said it explicitly',
        },
      },
      required: ['subject', 'predicate', 'value', 'source'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const listProfileFacts: ToolHandler = async (args, ctx) => {
  const a = args as { subject?: string }
  const params: unknown[] = [ctx.userId]
  let subjectClause = ''
  if (a.subject) {
    params.push(a.subject)
    subjectClause = ` AND subject = $${params.length}`
  }
  const { rows } = await ctx.client.query(
    `SELECT subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at
     FROM plannen.profile_facts
     WHERE user_id = $1 AND is_historical = false AND confidence >= 0.6${subjectClause}
     ORDER BY subject ASC, predicate ASC`,
    params,
  )
  return rows
}

const getHistoricalFacts: ToolHandler = async (args, ctx) => {
  const a = args as { subject?: string }
  const params: unknown[] = [ctx.userId]
  let subjectClause = ''
  if (a.subject) {
    params.push(a.subject)
    subjectClause = ` AND subject = $${params.length}`
  }
  const { rows } = await ctx.client.query(
    `SELECT subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at
     FROM plannen.profile_facts
     WHERE user_id = $1 AND is_historical = true${subjectClause}
     ORDER BY subject ASC, last_seen_at DESC`,
    params,
  )
  return rows
}

const correctProfileFact: ToolHandler = async (args, ctx) => {
  const a = args as {
    subject: string
    predicate: string
    old_value: string
    new_value: string
  }
  const { rows: existingRows } = await ctx.client.query(
    `SELECT id FROM plannen.profile_facts
     WHERE user_id = $1 AND subject = $2 AND predicate = $3
       AND value = $4 AND is_historical = false`,
    [ctx.userId, a.subject, a.predicate, a.old_value],
  )
  const existing = existingRows[0] as { id: string } | undefined

  if (existing) {
    await ctx.client.query(
      'UPDATE plannen.profile_facts SET is_historical = true WHERE id = $1',
      [existing.id],
    )
  }

  await ctx.client.query(
    `INSERT INTO plannen.profile_facts
       (user_id, subject, predicate, value, confidence, observed_count, source)
     VALUES ($1, $2, $3, $4, 1.0, 1, 'user_stated')`,
    [ctx.userId, a.subject, a.predicate, a.new_value],
  )
  return { action: 'corrected', old_value: a.old_value, new_value: a.new_value }
}

const upsertProfileFact: ToolHandler = async (args, ctx) => {
  const a = args as {
    subject: string
    predicate: string
    value: string
    source: FactSource
  }
  const { rows: existingRows } = await ctx.client.query(
    `SELECT id, value, confidence, observed_count FROM plannen.profile_facts
     WHERE user_id = $1 AND subject = $2 AND predicate = $3 AND is_historical = false`,
    [ctx.userId, a.subject, a.predicate],
  )
  const existing = existingRows[0] as
    | { id: string; value: string; confidence: number; observed_count: number }
    | undefined

  if (!existing) {
    await ctx.client.query(
      `INSERT INTO plannen.profile_facts
         (user_id, subject, predicate, value, confidence, observed_count, source)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [ctx.userId, a.subject, a.predicate, a.value, initialConfidence(a.source), a.source],
    )
    return { action: 'inserted' }
  }

  if (existing.value === a.value) {
    const newConfidence = computeCorroborationConfidence(existing.confidence)
    await ctx.client.query(
      `UPDATE plannen.profile_facts
       SET confidence = $1, observed_count = $2, last_seen_at = $3
       WHERE id = $4`,
      [newConfidence, existing.observed_count + 1, new Date().toISOString(), existing.id],
    )
    return { action: 'corroborated', confidence: newConfidence }
  }

  const decayedConfidence = computeContradictionConfidence(existing.confidence)
  await ctx.client.query(
    `UPDATE plannen.profile_facts
     SET confidence = $1, is_historical = $2
     WHERE id = $3`,
    [decayedConfidence, shouldMarkHistorical(decayedConfidence), existing.id],
  )

  await ctx.client.query(
    `INSERT INTO plannen.profile_facts
       (user_id, subject, predicate, value, confidence, observed_count, source)
     VALUES ($1, $2, $3, $4, $5, 1, $6)`,
    [ctx.userId, a.subject, a.predicate, a.value, initialConfidence(a.source), a.source],
  )
  return { action: 'contradicted', old_value: existing.value, new_value: a.value }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const profileFactsModule: ToolModule = {
  definitions,
  dispatch: {
    list_profile_facts: listProfileFacts,
    get_historical_facts: getHistoricalFacts,
    correct_profile_fact: correctProfileFact,
    upsert_profile_fact: upsertProfileFact,
  },
}
