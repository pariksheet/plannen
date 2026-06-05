import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import { upsertSource } from './_shared.ts'
import { parseSourceUrl, normaliseTags, validateName, validateSourceType } from './sourcesHelpers.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1963-2005) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'save_source',
    description:
      "Save a source (organiser, platform, or one-off page) as a standalone bookmark — without creating an event. Call this when the user explicitly asks to save/bookmark a link, says a specific link looks good (\"X looks good\", \"send X to whatsapp\"), or accepts the end-of-discovery batch ask. The agent must have the page content first (from WebFetch) so name/tags/source_type can be derived. Tags follow the same vocabulary as update_source — lead with the specific activity. Returns action: 'inserted' for a new bookmark, 'updated' when refreshing an existing one.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) source URL' },
        name: { type: 'string', description: 'Human-readable organiser/platform name' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 descriptive tags (activity first, then audience, geography, cadence, format)',
        },
        source_type: {
          type: 'string',
          enum: ['platform', 'organiser', 'one_off'],
          description:
            'platform = publishes many events; organiser = single entity with recurring events; one_off = single event page',
        },
      },
      required: ['url', 'name', 'tags', 'source_type'],
    },
  },
  {
    name: 'update_source',
    description:
      "Save analysis results for an event source. Call this after fetching the source's homepage and identifying what kinds of events it publishes. Assigns up to 10 tags from activity types (camp, workshop, sailing, climbing, music, sports, hiking, yoga, theatre), audience (kids, adults, family, teens), geography (country/city names), cadence (annual, seasonal, recurring), and format (residential, daytrip, online, weekend).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'event_sources UUID' },
        name: { type: 'string', description: 'Human-readable name of the organiser or platform' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 descriptive tags' },
        source_type: {
          type: 'string',
          enum: ['platform', 'organiser', 'one_off'],
          description:
            'platform = publishes many events (e.g. Eventbrite); organiser = single entity with recurring events; one_off = single event page',
        },
      },
      required: ['id', 'name', 'tags', 'source_type'],
    },
  },
  {
    name: 'get_unanalysed_sources',
    description:
      'Return all event sources that have never been analysed (last_analysed_at is null). Use when the user asks to analyse their sources, then fetch each source_url and call update_source for each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_sources',
    description:
      'Query the personal source library by tag overlap. Call this before doing a web search when the user asks a discovery question (e.g. "find me a sailing course"). Pick relevant tags from the question, call search_sources, fetch the returned URLs directly, then supplement with a web search.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to match against (uses array overlap — any match counts)',
        },
      },
      required: ['tags'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const saveSource: ToolHandler = async (args, ctx) => {
  const a = args as { url: string; name: string; tags: unknown[]; source_type: string }
  const { domain, sourceUrl } = parseSourceUrl(a.url)
  const name = validateName(a.name)
  const tags = normaliseTags(a.tags)
  const source_type = validateSourceType(a.source_type)

  const { rows: existingRows } = await ctx.client.query(
    'SELECT id FROM plannen.event_sources WHERE user_id = $1 AND domain = $2',
    [ctx.userId, domain],
  )
  const action: 'inserted' | 'updated' = existingRows.length > 0 ? 'updated' : 'inserted'

  const upserted = await upsertSource(ctx.client, ctx.userId, null, sourceUrl)
  if (!upserted) throw new Error('failed to upsert source')

  await ctx.client.query(
    `UPDATE plannen.event_sources
     SET name = $1, tags = $2, source_type = $3,
         last_analysed_at = $4, updated_at = $5
     WHERE id = $6 AND user_id = $7`,
    [
      name,
      tags,
      source_type,
      new Date().toISOString(),
      new Date().toISOString(),
      upserted.id,
      ctx.userId,
    ],
  )
  return { id: upserted.id, domain, action }
}

const updateSource: ToolHandler = async (args, ctx) => {
  const a = args as {
    id: string
    name: string
    tags: string[]
    source_type: 'platform' | 'organiser' | 'one_off'
  }
  const { rows: src } = await ctx.client.query(
    'SELECT id FROM plannen.event_sources WHERE id = $1 AND user_id = $2',
    [a.id, ctx.userId],
  )
  if (src.length === 0) throw new Error('Source not found')
  await ctx.client.query(
    `UPDATE plannen.event_sources
     SET name = $1, tags = $2, source_type = $3,
         last_analysed_at = $4, updated_at = $5
     WHERE id = $6`,
    [
      a.name,
      a.tags.slice(0, 10),
      a.source_type,
      new Date().toISOString(),
      new Date().toISOString(),
      a.id,
    ],
  )
  return { success: true }
}

const getUnanalysedSources: ToolHandler = async (_args, ctx) => {
  const { rows } = await ctx.client.query(
    `SELECT id, domain, source_url FROM plannen.event_sources
     WHERE user_id = $1 AND last_analysed_at IS NULL
     ORDER BY created_at ASC`,
    [ctx.userId],
  )
  return rows
}

const searchSources: ToolHandler = async (args, ctx) => {
  const a = args as { tags: string[] }
  if (!a.tags.length) return []
  const { rows } = await ctx.client.query(
    `SELECT id, domain, source_url, name, tags, source_type
     FROM plannen.event_sources
     WHERE user_id = $1 AND tags && $2 AND last_analysed_at IS NOT NULL`,
    [ctx.userId, a.tags],
  )
  return rows
}

// ── Module export ─────────────────────────────────────────────────────────────

export const sourcesModule: ToolModule = {
  definitions,
  dispatch: {
    save_source: saveSource,
    update_source: updateSource,
    get_unanalysed_sources: getUnanalysedSources,
    search_sources: searchSources,
  },
}
