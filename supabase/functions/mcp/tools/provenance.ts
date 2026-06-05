// supabase/functions/mcp/tools/provenance.ts
//
// Records the source that created a Plannen event (mailbox sync today; future
// gcal/ics adapters later). Used by the web UI to render the "Added by mailbox
// sync from <X>" section in the event modal and to back the sweep query.

import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

const definitions: ToolDefinition[] = [
  {
    name: 'add_event_provenance',
    description: "Record (or replace) the source that created an event. Called by /plannen-mailbox-sync after each create_event so the web UI can surface sender/subject and the mute UI can match retroactively.",
    inputSchema: {
      type: 'object',
      required: ['event_id', 'source'],
      properties: {
        event_id:          { type: 'string' },
        source:            { type: 'string', description: '"mailbox" today; "manual"/"gcal"/"ics" later.' },
        adapter_id:        { type: 'string' },
        source_message_id: { type: 'string' },
        sender_display:    { type: 'string', description: 'Raw From: header value, e.g. "Acme Life <n@e.acmelife.com>".' },
        sender_email:      { type: 'string', description: 'Lowercased address — set even when sender_display has wrapping.' },
        sender_domain:     { type: 'string', description: 'Lowercased host part of sender_email.' },
        subject:           { type: 'string' },
      },
    },
  },
  {
    name: 'get_event_provenance',
    description: 'Return the provenance row for an event, or null if none recorded.',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'string' } },
    },
  },
]

const addEventProvenance: ToolHandler = async (args, ctx) => {
  const a = args as {
    event_id?: string
    source?: string
    adapter_id?: string
    source_message_id?: string
    sender_display?: string
    sender_email?: string
    sender_domain?: string
    subject?: string
  }
  const eventId = (a.event_id ?? '').trim()
  const source = (a.source ?? '').trim()
  if (!eventId) throw new Error('event_id required')
  if (!source) throw new Error('source required')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.event_provenance
       (event_id, source, adapter_id, source_message_id,
        sender_display, sender_email, sender_domain, subject)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id) DO UPDATE SET
       source = EXCLUDED.source,
       adapter_id = EXCLUDED.adapter_id,
       source_message_id = EXCLUDED.source_message_id,
       sender_display = EXCLUDED.sender_display,
       sender_email = EXCLUDED.sender_email,
       sender_domain = EXCLUDED.sender_domain,
       subject = EXCLUDED.subject
     RETURNING *`,
    [
      eventId,
      source,
      a.adapter_id ?? null,
      a.source_message_id ?? null,
      a.sender_display ?? null,
      a.sender_email ?? null,
      a.sender_domain ?? null,
      a.subject ?? null,
    ],
  )
  return rows[0]
}

const getEventProvenance: ToolHandler = async (args, ctx) => {
  const a = args as { event_id?: string }
  const eventId = (a.event_id ?? '').trim()
  if (!eventId) throw new Error('event_id required')
  const { rows } = await ctx.client.query(
    `SELECT p.* FROM plannen.event_provenance p
       JOIN plannen.events e ON e.id = p.event_id
      WHERE p.event_id = $1 AND e.created_by = $2`,
    [eventId, ctx.userId],
  )
  return rows[0] ?? null
}

export const provenanceModule: ToolModule = {
  definitions,
  dispatch: {
    add_event_provenance: addEventProvenance,
    get_event_provenance: getEventProvenance,
  },
}
