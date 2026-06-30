import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { withDb } from '../_shared/db.ts'
import { verifyJwt } from '../_shared/jwt.ts'
import { getUserTimezone } from '../mcp/tools/_shared.ts'
import type { ToolCtx } from '../mcp/types.ts'
import { runModelTurn, dispatchTool } from './agent.ts'
import { getUsage, incrementUsage } from './quota.ts'
import {
  DAILY_LIMIT,
  DECLINE_MESSAGE,
  buildSystemPrompt,
  decideConfirm,
  executionReceipt,
  isValidTimeZone,
  isWriteTool,
  localNowIso,
  nextMidnightIso,
  proposalSummary,
  rewriteDateArgs,
  usageDateFor,
  type AgentRequest,
  type AgentResponse,
  type Usage,
  type WriteTool,
} from './logic.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Best-effort, owner-scoped label for the Confirm prompt. The MCP handlers
// bypass RLS, so we scope by created_by ourselves; a miss just falls back to
// whatever the args carry. Display-only — execution on Confirm goes through the
// real handler, which enforces access.
async function resolveLabel(
  ctx: ToolCtx,
  tool: WriteTool,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    if (tool === 'update_event' && args.id) {
      const { rows } = await ctx.client.query(
        `SELECT title FROM plannen.events WHERE id = $1 AND created_by = $2 LIMIT 1`,
        [args.id, ctx.userId],
      )
      return rows[0]?.title as string | undefined
    }
    if ((tool === 'check_checklist_item' || tool === 'uncheck_checklist_item') && args.item_id) {
      const { rows } = await ctx.client.query(
        `SELECT text FROM plannen.checklist_items WHERE id = $1 LIMIT 1`,
        [args.item_id],
      )
      return rows[0]?.text as string | undefined
    }
    if (tool === 'add_checklist_items' && args.checklist_id) {
      const { rows } = await ctx.client.query(
        `SELECT title FROM plannen.checklists WHERE id = $1 LIMIT 1`,
        [args.checklist_id],
      )
      return rows[0]?.title as string | undefined
    }
  } catch {
    // ignore — fall back to args-derived label
  }
  return undefined
}

async function handle(ctx: ToolCtx, body: AgentRequest): Promise<AgentResponse> {
  // Interpret times in the user's CURRENT device timezone (where they
  // physically are), matching the event form + device-local display. Fall back
  // to the stored home/profile TZ when the client doesn't supply a valid one
  // (e.g. background/non-device callers).
  const clientTz = body.context?.client_timezone
  const tz = isValidTimeZone(clientTz) ? clientTz : await getUserTimezone(ctx.client, ctx.userId)
  const now = new Date()
  const usageDate = usageDateFor(now, tz)
  const resetsAt = nextMidnightIso(now, tz)

  // ── Confirm path: execute the echoed proposal directly, no model, no charge.
  if (body.confirm) {
    const { tool } = body.confirm
    if (!isWriteTool(tool)) {
      const used = await getUsage(ctx.client, ctx.userId, usageDate)
      return {
        assistant_text: 'That action is not allowed.',
        proposed_action: null,
        executed_action: null,
        usage: { used, limit: DAILY_LIMIT, resets_at: resetsAt },
        error: 'unsupported_tool',
      }
    }
    // Idempotent: proposal args were already resolved when proposed; re-run is a
    // no-op on already-absolute values but covers any client-constructed confirm.
    const args = rewriteDateArgs(tool, body.confirm.args ?? {}, tz)
    const result = await dispatchTool(tool, args, ctx)
    const used = await getUsage(ctx.client, ctx.userId, usageDate)
    return {
      assistant_text: executionReceipt(tool, args, result, tz),
      proposed_action: null,
      executed_action: { tool, summary: executionReceipt(tool, args, result, tz) },
      usage: { used, limit: DAILY_LIMIT, resets_at: resetsAt },
      error: null,
    }
  }

  // ── Model path: quota gate BEFORE calling the model.
  const usedBefore = await getUsage(ctx.client, ctx.userId, usageDate)
  if (usedBefore >= DAILY_LIMIT) {
    return {
      assistant_text: `You've used today's ${DAILY_LIMIT} assistant requests. Resets at midnight.`,
      proposed_action: null,
      executed_action: null,
      usage: { used: usedBefore, limit: DAILY_LIMIT, resets_at: resetsAt },
      error: 'quota_exceeded',
    }
  }

  const used = await incrementUsage(ctx.client, ctx.userId, usageDate)
  const usage: Usage = { used, limit: DAILY_LIMIT, resets_at: resetsAt }

  // Inject the wall-clock "now" in the device TZ so relative dates resolve to
  // the user's current local time, not their home/profile TZ.
  const system = buildSystemPrompt({ nowIso: localNowIso(now, tz), tz, context: body.context })
  const turn = await runModelTurn({ system, messages: body.messages ?? [], ctx })

  // No write call → decline / off-topic dead-end.
  if (!turn.writeCall) {
    return {
      assistant_text: turn.text?.trim() || DECLINE_MESSAGE,
      proposed_action: null,
      executed_action: null,
      usage,
      error: null,
    }
  }

  const { tool } = turn.writeCall
  // Resolve naive datetimes the model emitted (e.g. "12:00 today") against the
  // device TZ → absolute UTC, before proposing or executing. Same result the
  // event form produces from a datetime-local input.
  const args = rewriteDateArgs(tool, turn.writeCall.args, tz)
  const needsConfirm = decideConfirm({ tool, args, usedLookup: turn.usedLookup })

  if (needsConfirm) {
    const label = await resolveLabel(ctx, tool, args)
    const summary = proposalSummary(tool, args, label)
    return {
      assistant_text: summary,
      proposed_action: { tool, args, summary },
      executed_action: null,
      usage,
      error: null,
    }
  }

  // Direct execution (clear-context create / edit / checklist tick / log).
  const result = await dispatchTool(tool, args, ctx)
  const receipt = executionReceipt(tool, args, result, tz)
  return {
    assistant_text: receipt,
    proposed_action: null,
    executed_action: { tool, summary: receipt },
    usage,
    error: null,
  }
}

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

  let userId: string
  try {
    userId = await verifyJwt(req.headers.get('authorization'))
  } catch (e) {
    return json({ error: (e as Error).message }, 401)
  }

  try {
    const body = (await req.json()) as AgentRequest
    const out = await withDb(userId, (db) =>
      handle({ client: db as unknown as ToolCtx['client'], userId }, body),
    )
    return json(out, 200)
  } catch (e) {
    return json(
      {
        assistant_text: 'Something went wrong handling that. Please try again.',
        proposed_action: null,
        executed_action: null,
        usage: null,
        error: e instanceof Error ? e.message : String(e),
      },
      500,
    )
  }
})
