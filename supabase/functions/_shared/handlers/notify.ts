// Server-side push fan-out for social events that bypass the Node backend.
//
// The Tier 1/2 client writes shares + RSVPs directly to Supabase via
// supabase-js, so there is no natural backend hook to trigger web push. This
// handler fills the gap: after the client writes, it POSTs here, we resolve
// recipients server-side (RLS-bypass via direct pg pool), and sendPush fans
// out per recipient.
//
// Kinds:
//   rsvp           → notify event creator (skip if sender is creator)
//   event_shared   → notify members of given groups + named users (sender must
//                    own the event)
//   story_shared   → notify members of given groups + named users (sender must
//                    own the story)

import { sendPush, type PushPayload } from './push.ts'
import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface RsvpBody {
  kind: 'rsvp'
  event_id: string
  status: 'going' | 'maybe' | 'not_going'
}

interface EventSharedBody {
  kind: 'event_shared'
  event_id: string
  group_ids?: string[]
  user_ids?: string[]
}

interface StorySharedBody {
  kind: 'story_shared'
  story_id: string
  group_ids?: string[]
  user_ids?: string[]
}

type NotifyBody = RsvpBody | EventSharedBody | StorySharedBody

function isUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)
}

function parseBody(raw: unknown): NotifyBody | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'invalid_body' }
  const b = raw as Record<string, unknown>
  if (b.kind === 'rsvp') {
    if (!isUuid(b.event_id)) return { error: 'invalid_event_id' }
    if (b.status !== 'going' && b.status !== 'maybe' && b.status !== 'not_going') return { error: 'invalid_status' }
    return { kind: 'rsvp', event_id: b.event_id, status: b.status }
  }
  if (b.kind === 'event_shared') {
    if (!isUuid(b.event_id)) return { error: 'invalid_event_id' }
    const group_ids = Array.isArray(b.group_ids) ? (b.group_ids as unknown[]).filter(isUuid) : []
    const user_ids = Array.isArray(b.user_ids) ? (b.user_ids as unknown[]).filter(isUuid) : []
    return { kind: 'event_shared', event_id: b.event_id, group_ids, user_ids }
  }
  if (b.kind === 'story_shared') {
    if (!isUuid(b.story_id)) return { error: 'invalid_story_id' }
    const group_ids = Array.isArray(b.group_ids) ? (b.group_ids as unknown[]).filter(isUuid) : []
    const user_ids = Array.isArray(b.user_ids) ? (b.user_ids as unknown[]).filter(isUuid) : []
    return { kind: 'story_shared', story_id: b.story_id, group_ids, user_ids }
  }
  return { error: 'unknown_kind' }
}

async function senderLabel(db: HandlerCtx['db'], userId: string): Promise<string> {
  const { rows } = await db.query(
    'SELECT full_name, email FROM plannen.users WHERE id = $1',
    [userId],
  )
  const row = rows[0] as { full_name?: string | null; email?: string | null } | undefined
  const name = row?.full_name?.trim()
  if (name) return name
  const email = row?.email
  if (email) return email.split('@')[0]
  return 'Someone'
}

async function resolveGroupMembers(
  db: HandlerCtx['db'],
  groupIds: string[],
): Promise<string[]> {
  if (groupIds.length === 0) return []
  const { rows } = await db.query(
    'SELECT DISTINCT user_id FROM plannen.friend_group_members WHERE group_id = ANY($1::uuid[])',
    [groupIds],
  )
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id)
}

function uniqueExceptSender(recipients: string[], senderId: string): string[] {
  const set = new Set(recipients)
  set.delete(senderId)
  return Array.from(set)
}

interface NotifyResult {
  attempted: number
  sent: number
  removed: number
  recipients: number
  errors: string[]
}

async function fanOut(
  db: HandlerCtx['db'],
  recipients: string[],
  payload: PushPayload,
): Promise<NotifyResult> {
  const totals: NotifyResult = {
    attempted: 0,
    sent: 0,
    removed: 0,
    recipients: recipients.length,
    errors: [],
  }
  if (recipients.length === 0) return totals
  const per = await Promise.all(recipients.map((uid) => sendPush(db, uid, payload)))
  for (const r of per) {
    totals.attempted += r.attempted
    totals.sent += r.sent
    totals.removed += r.removed
    if (r.errors.length) totals.errors.push(...r.errors)
  }
  return totals
}

async function handleRsvp(
  body: RsvpBody,
  ctx: HandlerCtx,
): Promise<Response> {
  const { rows } = await ctx.db.query(
    'SELECT title, created_by FROM plannen.events WHERE id = $1',
    [body.event_id],
  )
  const ev = rows[0] as { title: string | null; created_by: string } | undefined
  if (!ev) return jsonResp(404, { error: 'event_not_found' })
  const recipients = uniqueExceptSender([ev.created_by], ctx.userId)
  if (recipients.length === 0) return jsonResp(200, { recipients: 0, sent: 0 })
  const sender = await senderLabel(ctx.db, ctx.userId)
  const statusLabel = body.status === 'going' ? 'going' : body.status === 'maybe' ? 'maybe' : 'not going'
  const title = ev.title ?? 'your event'
  const result = await fanOut(ctx.db, recipients, {
    title: `${sender} RSVP'd ${statusLabel}`,
    body: title,
    url: `/events/${body.event_id}`,
    tag: `rsvp-${body.event_id}-${ctx.userId}`,
  })
  return jsonResp(200, result)
}

async function handleEventShared(
  body: EventSharedBody,
  ctx: HandlerCtx,
): Promise<Response> {
  const { rows } = await ctx.db.query(
    'SELECT title, created_by FROM plannen.events WHERE id = $1',
    [body.event_id],
  )
  const ev = rows[0] as { title: string | null; created_by: string } | undefined
  if (!ev) return jsonResp(404, { error: 'event_not_found' })
  if (ev.created_by !== ctx.userId) return jsonResp(403, { error: 'not_event_owner' })
  const groupMembers = await resolveGroupMembers(ctx.db, body.group_ids ?? [])
  const recipients = uniqueExceptSender([...groupMembers, ...(body.user_ids ?? [])], ctx.userId)
  if (recipients.length === 0) return jsonResp(200, { recipients: 0, sent: 0 })
  const sender = await senderLabel(ctx.db, ctx.userId)
  const title = ev.title ?? 'an event'
  const result = await fanOut(ctx.db, recipients, {
    title: `${sender} shared an event`,
    body: title,
    url: `/events/${body.event_id}`,
    tag: `event-new-${body.event_id}`,
  })
  return jsonResp(200, result)
}

async function handleStoryShared(
  body: StorySharedBody,
  ctx: HandlerCtx,
): Promise<Response> {
  const { rows } = await ctx.db.query(
    'SELECT title, user_id FROM plannen.stories WHERE id = $1',
    [body.story_id],
  )
  const st = rows[0] as { title: string | null; user_id: string } | undefined
  if (!st) return jsonResp(404, { error: 'story_not_found' })
  if (st.user_id !== ctx.userId) return jsonResp(403, { error: 'not_story_owner' })
  const groupMembers = await resolveGroupMembers(ctx.db, body.group_ids ?? [])
  const recipients = uniqueExceptSender([...groupMembers, ...(body.user_ids ?? [])], ctx.userId)
  if (recipients.length === 0) return jsonResp(200, { recipients: 0, sent: 0 })
  const sender = await senderLabel(ctx.db, ctx.userId)
  const title = st.title ?? 'a story'
  const result = await fanOut(ctx.db, recipients, {
    title: `${sender} shared a story`,
    body: title,
    url: `/stories/${body.story_id}`,
    tag: `story-${body.story_id}`,
  })
  return jsonResp(200, result)
}

export async function handleNotify(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return jsonResp(405, { error: 'method_not_allowed' })
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonResp(400, { error: 'invalid_json' })
  }
  const parsed = parseBody(raw)
  if ('error' in parsed) return jsonResp(400, { error: parsed.error })
  switch (parsed.kind) {
    case 'rsvp':
      return handleRsvp(parsed, ctx)
    case 'event_shared':
      return handleEventShared(parsed, ctx)
    case 'story_shared':
      return handleStoryShared(parsed, ctx)
  }
}
