import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1720-1782) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'create_story',
    description:
      'Create (or overwrite, if event_ids has length 1 and a story already exists for that event AT THE SAME LANGUAGE) an AI-generated story. Pass language to write a non-English story (default "en"). Pass story_group_id to link this row as a translation of an existing story group — siblings sharing a story_group_id render as language pills in the UI. Single-event overwrite is now scoped by (event, language); generating an EN story for event X does NOT overwrite the NL one. cover_url defaults to the first IMAGE memory by taken_at across linked events.',
    inputSchema: {
      type: 'object',
      properties: {
        event_ids:      { type: 'array', items: { type: 'string' }, description: 'One or more event UUIDs' },
        title:          { type: 'string' },
        body:           { type: 'string', description: 'Markdown allowed' },
        user_notes:     { type: 'string', description: 'Optional reflection from the user' },
        mood:           { type: 'string', description: 'Optional, e.g. "chill", "memorable"' },
        tone:           { type: 'string', description: 'Optional, e.g. "diary", "postcard"' },
        cover_url:      { type: 'string', description: 'Optional override; defaults to first IMAGE memory by taken_at' },
        date_from:      { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
        date_to:        { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
        language:       { type: 'string', description: 'BCP-47 short code, e.g. "en", "nl", "fr". Default "en".' },
        story_group_id: { type: 'string', description: 'UUID; pass when creating a sibling translation of an existing story so they share a group.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'update_story',
    description: 'Update title, body, or cover_url on a story. The trigger stamps edited_at when title or body changes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Story UUID' },
        title: { type: 'string' },
        body: { type: 'string' },
        cover_url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_story',
    description:
      "Fetch a single story by id, including a small array of linked event summaries (id, title, start_date) and a siblings array [{id, language}] of all translations sharing this story's story_group_id (including itself).",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_stories',
    description: "List the current user's stories, ordered by generated_at DESC. Each row includes a small events array for subtitles.",
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Default 50' },
        offset: { type: 'number', description: 'Default 0' },
      },
    },
  },
  {
    name: 'delete_story',
    description: 'Delete a story (cascades to story_events).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const createStory: ToolHandler = async (args, ctx) => {
  const a = args as {
    event_ids?: string[]
    title: string
    body: string
    user_notes?: string
    mood?: string
    tone?: string
    cover_url?: string
    date_from?: string
    date_to?: string
    language?: string
    story_group_id?: string
  }
  const eventIds = a.event_ids ?? []
  if (!a.title?.trim()) throw new Error('title is required')
  if (!a.body?.trim()) throw new Error('body is required')
  if (!eventIds.length && !(a.date_from && a.date_to)) {
    throw new Error('Provide event_ids or both date_from and date_to')
  }

  if (eventIds.length) {
    const { rows: events } = await ctx.client.query(
      'SELECT id, created_by FROM plannen.events WHERE id = ANY($1)',
      [eventIds],
    )
    const ownedIds = new Set(
      events
        .filter((e: { created_by: string }) => e.created_by === ctx.userId)
        .map((e: { id: string }) => e.id),
    )
    const missing = eventIds.filter((id) => !ownedIds.has(id))
    if (missing.length) throw new Error(`Events not found or not owned: ${missing.join(', ')}`)
  }

  if (eventIds.length === 1) {
    const lang = a.language ?? 'en'
    const { rows: existingRows } = await ctx.client.query(
      `SELECT se.story_id
       FROM plannen.story_events se
       JOIN plannen.stories s ON s.id = se.story_id
       WHERE se.event_id = $1 AND s.user_id = $2 AND s.language = $3
       LIMIT 1`,
      [eventIds[0], ctx.userId, lang],
    )
    const existing = existingRows[0] as { story_id: string } | undefined
    if (existing?.story_id) {
      const setClauses = [
        'title = $1', 'body = $2', 'user_notes = $3', 'mood = $4', 'tone = $5', 'generated_at = $6',
      ]
      const params: unknown[] = [
        a.title,
        a.body,
        a.user_notes ?? null,
        a.mood ?? null,
        a.tone ?? null,
        new Date().toISOString(),
      ]
      if (a.cover_url !== undefined) { params.push(a.cover_url); setClauses.push(`cover_url = $${params.length}`) }
      if (a.story_group_id) { params.push(a.story_group_id); setClauses.push(`story_group_id = $${params.length}`) }
      params.push(existing.story_id)
      const { rows } = await ctx.client.query(
        `UPDATE plannen.stories SET ${setClauses.join(', ')}
         WHERE id = $${params.length}
         RETURNING id, story_group_id, language`,
        params,
      )
      if (rows.length === 0) throw new Error('Story update failed')
      const data = rows[0] as { id: string; story_group_id: string; language: string }
      return { id: data.id, story_group_id: data.story_group_id, language: data.language, overwritten: true }
    }
  }

  let coverUrl: string | null = a.cover_url ?? null
  if (!coverUrl && eventIds.length) {
    const { rows: mem } = await ctx.client.query(
      `SELECT media_url FROM plannen.event_memories
       WHERE event_id = ANY($1) AND media_url IS NOT NULL AND media_type = 'image'
       ORDER BY taken_at ASC NULLS LAST, created_at ASC
       LIMIT 1`,
      [eventIds],
    )
    coverUrl = (mem[0]?.media_url as string | undefined) ?? null
  }

  const insertCols = ['user_id', 'title', 'body', 'cover_url', 'user_notes', 'mood', 'tone', 'date_from', 'date_to', 'language']
  const insertVals: unknown[] = [
    ctx.userId, a.title, a.body, coverUrl,
    a.user_notes ?? null, a.mood ?? null, a.tone ?? null,
    a.date_from ?? null, a.date_to ?? null, a.language ?? 'en',
  ]
  if (a.story_group_id) { insertCols.push('story_group_id'); insertVals.push(a.story_group_id) }
  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ')
  const { rows: storyRows } = await ctx.client.query(
    `INSERT INTO plannen.stories (${insertCols.join(', ')})
     VALUES (${placeholders})
     RETURNING id, story_group_id, language`,
    insertVals,
  )
  if (storyRows.length === 0) throw new Error('Story insert failed')
  const story = storyRows[0] as { id: string; story_group_id: string; language: string }

  for (const event_id of eventIds) {
    await ctx.client.query(
      'INSERT INTO plannen.story_events (story_id, event_id) VALUES ($1, $2)',
      [story.id, event_id],
    )
  }

  return { id: story.id, story_group_id: story.story_group_id, language: story.language, overwritten: false }
}

const updateStory: ToolHandler = async (args, ctx) => {
  const a = args as { id: string; title?: string; body?: string; cover_url?: string }
  const setClauses: string[] = []
  const params: unknown[] = []
  if (a.title !== undefined) { params.push(a.title); setClauses.push(`title = $${params.length}`) }
  if (a.body !== undefined) { params.push(a.body); setClauses.push(`body = $${params.length}`) }
  if (a.cover_url !== undefined) { params.push(a.cover_url); setClauses.push(`cover_url = $${params.length}`) }
  if (setClauses.length === 0) throw new Error('No fields to update')
  params.push(a.id)
  params.push(ctx.userId)
  const { rows } = await ctx.client.query(
    `UPDATE plannen.stories SET ${setClauses.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING *`,
    params,
  )
  if (rows.length === 0) throw new Error('Not found')
  const story = rows[0] as Record<string, unknown> & { id: string }
  const { rows: linkRows } = await ctx.client.query(
    `SELECT e.id, e.title, e.start_date
     FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
     WHERE se.story_id = $1`,
    [story.id],
  )
  return { ...story, events: linkRows }
}

const getStory: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const { rows: storyRows } = await ctx.client.query(
    'SELECT * FROM plannen.stories WHERE id = $1 AND user_id = $2',
    [a.id, ctx.userId],
  )
  if (storyRows.length === 0) return null
  const story = storyRows[0] as Record<string, unknown> & { id: string; story_group_id: string }
  const { rows: eventRows } = await ctx.client.query(
    `SELECT e.id, e.title, e.start_date
     FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
     WHERE se.story_id = $1`,
    [story.id],
  )
  const { rows: siblings } = await ctx.client.query(
    `SELECT id, language FROM plannen.stories
     WHERE story_group_id = $1 ORDER BY generated_at ASC`,
    [story.story_group_id],
  )
  return { ...story, events: eventRows, siblings }
}

const listStories: ToolHandler = async (args, ctx) => {
  const a = args as { limit?: number; offset?: number }
  const limit = a.limit ?? 50
  const offset = a.offset ?? 0
  const { rows: storyRows } = await ctx.client.query(
    `SELECT * FROM plannen.stories WHERE user_id = $1
     ORDER BY generated_at DESC
     OFFSET $2 LIMIT $3`,
    [ctx.userId, offset, limit],
  )
  if (storyRows.length === 0) return []
  const ids = storyRows.map((r: { id: string }) => r.id)
  const { rows: linkRows } = await ctx.client.query(
    `SELECT se.story_id, e.id, e.title, e.start_date
     FROM plannen.story_events se JOIN plannen.events e ON e.id = se.event_id
     WHERE se.story_id = ANY($1)`,
    [ids],
  )
  const byStory = new Map<string, Array<{ id: string; title: string | null; start_date: string | null }>>()
  for (const r of linkRows as Array<{ story_id: string; id: string; title: string | null; start_date: string | null }>) {
    const arr = byStory.get(r.story_id) ?? []
    arr.push({ id: r.id, title: r.title, start_date: r.start_date })
    byStory.set(r.story_id, arr)
  }
  return storyRows.map((row: Record<string, unknown> & { id: string }) => ({
    ...row,
    events: byStory.get(row.id) ?? [],
  }))
}

const deleteStory: ToolHandler = async (args, ctx) => {
  const a = args as { id: string }
  const { rowCount } = await ctx.client.query(
    'DELETE FROM plannen.stories WHERE id = $1 AND user_id = $2',
    [a.id, ctx.userId],
  )
  if (!rowCount) throw new Error('Not found')
  return { success: true }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const storiesModule: ToolModule = {
  definitions,
  dispatch: {
    create_story: createStory,
    update_story: updateStory,
    get_story: getStory,
    list_stories: listStories,
    delete_story: deleteStory,
  },
}
