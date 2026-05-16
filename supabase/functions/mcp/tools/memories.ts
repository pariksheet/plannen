import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1678-1706) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'add_event_memory',
    description:
      'Attach a photo, video, or audio clip from an external source (Google Photos, Google Drive) to an event by external id only. NOTE: for Google Photos, prefer create_photo_picker_session + poll_photo_picker_session — those download the bytes and store them locally so the UI can display the media. add_event_memory only stores the id and is for advanced/manual cases. Idempotent on (event_id, external_id).',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event UUID' },
        external_id: { type: 'string', description: 'Google Photos mediaItem id (or Drive file id)' },
        source: {
          type: 'string',
          enum: ['google_photos', 'google_drive'],
          description: 'Provider; defaults to google_photos',
        },
        caption: { type: 'string', description: 'Optional caption' },
        media_type: {
          type: 'string',
          enum: ['image', 'video', 'audio'],
          description: 'Kind of media being attached. Defaults to image for backwards compat.',
        },
      },
      required: ['event_id', 'external_id'],
    },
  },
  {
    name: 'list_event_memories',
    description:
      'List memories attached to an event, ordered by taken_at ASC (NULLS LAST), then created_at ASC. Returns id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at. The transcript field is populated for audio memories that have been transcribed via transcribe_memory; null otherwise. Use it for story context.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event UUID' },
      },
      required: ['event_id'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

const addEventMemory: ToolHandler = async (args, ctx) => {
  const a = args as {
    event_id: string
    external_id: string
    source?: 'google_photos' | 'google_drive'
    caption?: string
    media_type?: 'image' | 'video' | 'audio'
  }
  const source = a.source ?? 'google_photos'
  const mediaType = a.media_type ?? 'image'
  // ignoreDuplicates semantics: only insert if (event_id, external_id) is new.
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.event_memories
       (event_id, user_id, media_url, media_type, source, external_id, caption)
     VALUES ($1, $2, NULL, $3, $4, $5, $6)
     ON CONFLICT (event_id, external_id) DO NOTHING
     RETURNING id`,
    [a.event_id, ctx.userId, mediaType, source, a.external_id, a.caption ?? null],
  )
  const inserted = rows[0] as { id: string } | undefined
  return {
    attached: !!inserted,
    id: inserted?.id ?? null,
    event_id: a.event_id,
    external_id: a.external_id,
  }
}

const listEventMemories: ToolHandler = async (args, ctx) => {
  const a = args as { event_id: string }
  const { rows: evtRows } = await ctx.client.query(
    'SELECT id, created_by FROM plannen.events WHERE id = $1',
    [a.event_id],
  )
  if (evtRows.length === 0) throw new Error('Not found')
  if ((evtRows[0] as { created_by: string }).created_by !== ctx.userId) throw new Error('Event not found')
  const { rows } = await ctx.client.query(
    `SELECT id, event_id, media_url, media_type, caption, taken_at, created_at,
            external_id, source, transcript, transcript_lang, transcribed_at
     FROM plannen.event_memories
     WHERE event_id = $1
     ORDER BY taken_at ASC NULLS LAST, created_at ASC`,
    [a.event_id],
  )
  return rows
}

// ── Module export ─────────────────────────────────────────────────────────────

export const memoriesModule: ToolModule = {
  definitions,
  dispatch: {
    add_event_memory: addEventMemory,
    list_event_memories: listEventMemories,
  },
}
