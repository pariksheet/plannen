import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'
import { getGoogleAccessToken } from './_shared.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:1784-1799) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'create_photo_picker_session',
    description:
      'Create a Google Photos picker session. Returns picker_uri (open in browser to pick photos) and session_id. After the user selects photos, call poll_photo_picker_session with the session_id and the target event_id to download the bytes into Plannen and attach as memories. Single-user local-only — uses the OAuth token connected via the Plannen UI.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'poll_photo_picker_session',
    description:
      'Poll a Google Photos picker session. If the user has finished picking, downloads each selected photo, uploads bytes to the event-photos storage bucket, and creates event_memories rows so the photos appear in the Plannen UI for the given event. Idempotent: re-attaching the same picker id is silently skipped. Returns { status: "pending" } if user has not finished, otherwise { status: "complete", attached: [...], skipped: [...] }.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id returned by create_photo_picker_session',
        },
        event_id: {
          type: 'string',
          description: 'Plannen event UUID to attach the picked photos to',
        },
      },
      required: ['session_id', 'event_id'],
    },
  },
]

// ── Shared types ──────────────────────────────────────────────────────────────

interface PickedMediaItem {
  id?: string
  type?: string
  createTime?: string
  mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string }
}

const PICKER_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

const createPhotoPickerSession: ToolHandler = async (_args, ctx) => {
  const accessToken = await getGoogleAccessToken(ctx.client, ctx.userId)
  const res = await fetch('https://photospicker.googleapis.com/v1/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`Failed to create picker session: ${res.status} ${await res.text()}`)
  const session = (await res.json()) as {
    id: string
    pickerUri: string
    expireTime?: string
    mediaItemsSet?: boolean
  }
  return {
    session_id: session.id,
    picker_uri: session.pickerUri,
    expires_at: session.expireTime ?? null,
    instructions:
      'Open picker_uri in a browser, select photos for the event, then call poll_photo_picker_session with the session_id and event_id.',
  }
}

const pollPhotoPickerSession: ToolHandler = async (args, ctx) => {
  const a = args as { session_id: string; event_id: string }
  const accessToken = await getGoogleAccessToken(ctx.client, ctx.userId)

  const sessionRes = await fetch(
    `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(a.session_id)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!sessionRes.ok) {
    throw new Error(`Failed to fetch session: ${sessionRes.status} ${await sessionRes.text()}`)
  }
  const session = (await sessionRes.json()) as { mediaItemsSet?: boolean }
  if (!session.mediaItemsSet) return { status: 'pending' as const }

  const items: PickedMediaItem[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ sessionId: a.session_id, pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const listRes = await fetch(
      `https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!listRes.ok) {
      throw new Error(`Failed to list picker items: ${listRes.status} ${await listRes.text()}`)
    }
    const page = (await listRes.json()) as {
      mediaItems?: PickedMediaItem[]
      nextPageToken?: string
    }
    if (page.mediaItems) items.push(...page.mediaItems)
    pageToken = page.nextPageToken
  } while (pageToken)

  const attached: {
    external_id: string
    memory_id: string
    filename?: string
    already?: boolean
  }[] = []
  const skipped: { external_id: string; reason: string }[] = []

  for (const item of items) {
    if (!item.id || !item.mediaFile?.baseUrl) {
      skipped.push({ external_id: item.id ?? '', reason: 'missing id or baseUrl' })
      continue
    }
    if (item.type && item.type !== 'PHOTO') {
      skipped.push({ external_id: item.id, reason: `unsupported type ${item.type}` })
      continue
    }

    const { rows: existingRows } = await ctx.client.query(
      'SELECT id FROM plannen.event_memories WHERE event_id = $1 AND external_id = $2',
      [a.event_id, item.id],
    )
    const existing = existingRows[0] as { id: string } | undefined
    if (existing) {
      attached.push({
        external_id: item.id,
        memory_id: existing.id,
        filename: item.mediaFile.filename,
        already: true,
      })
      continue
    }

    const bytesRes = await fetch(`${item.mediaFile.baseUrl}=d`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!bytesRes.ok) {
      skipped.push({ external_id: item.id, reason: `download failed ${bytesRes.status}` })
      continue
    }
    // bytes are intentionally discarded; storage upload is future work for the HTTP MCP.
    const mimeType =
      item.mediaFile.mimeType ?? bytesRes.headers.get('Content-Type') ?? 'image/jpeg'
    const ext = PICKER_MIME_TO_EXT[mimeType.toLowerCase()] ?? 'jpg'
    const path = `${a.event_id}/${ctx.userId}/${item.id}.${ext}`
    const publicUrl = `/storage/v1/object/public/event-photos/${path}`

    const { rows: insertedRows } = await ctx.client.query(
      `INSERT INTO plannen.event_memories
         (event_id, user_id, source, external_id, media_url, media_type, taken_at)
       VALUES ($1, $2, 'google_photos', $3, $4, 'image', $5)
       RETURNING id`,
      [a.event_id, ctx.userId, item.id, publicUrl, item.createTime ?? null],
    )
    const inserted = insertedRows[0] as { id: string } | undefined
    if (!inserted) {
      skipped.push({ external_id: item.id, reason: 'insert failed: unknown' })
      continue
    }
    attached.push({
      external_id: item.id,
      memory_id: inserted.id,
      filename: item.mediaFile.filename,
    })
  }

  return { status: 'complete' as const, attached, skipped, total_selected: items.length }
}

// ── Module export ─────────────────────────────────────────────────────────────

export const photosModule: ToolModule = {
  definitions,
  dispatch: {
    create_photo_picker_session: createPhotoPickerSession,
    poll_photo_picker_session: pollPhotoPickerSession,
  },
}
