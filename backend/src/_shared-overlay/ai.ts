// Node-tree variant of the BYOK AI dispatcher. Same surface as the Deno copy
// in `supabase/functions/_shared/ai.ts`, but wires the Tier-0 `claude-code-cli`
// subprocess provider that Deno cannot host. The overlay copy is layered on
// top of the staged Deno tree by `backend/scripts/prepare-shared.mjs`.

import { z } from 'zod'
import type { HandlerCtx } from './handlers/types.js'
import type {
  AIProvider,
  GenerateOpts,
  GenerateStructuredOpts,
  GenerateFromImageOpts,
  Provider,
} from './providers/types.js'
import { anthropicProvider } from './providers/anthropic.js'
import { claudeCliProvider } from './providers/claude-cli.js'

export type { Provider } from './providers/types.js'

export type AISettings = {
  provider: Provider
  api_key: string | null   // null for claude-code-cli; string for anthropic
  default_model: string | null
  base_url: string | null
  user_id: string
}

export type AIErrorCode =
  | 'no_provider_configured'
  | 'invalid_api_key'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'unknown_error'

export class AIError extends Error {
  code: AIErrorCode
  retryAfterSeconds: number | null
  status: number

  constructor(code: AIErrorCode, message: string, opts: { status?: number; retryAfterSeconds?: number | null } = {}) {
    super(message)
    this.name = 'AIError'
    this.code = code
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
    this.status = opts.status ?? statusForCode(code)
  }
}

export class AIProviderNotConfigured extends AIError {
  constructor() {
    super('no_provider_configured', 'No AI provider configured for this user.', { status: 400 })
  }
}

function statusForCode(code: AIErrorCode): number {
  switch (code) {
    case 'no_provider_configured':
    case 'invalid_api_key':
    case 'model_unavailable':
      return 400
    case 'rate_limited':
      return 429
    case 'provider_unavailable':
      return 502
    default:
      return 500
  }
}

// ── Auth + settings lookup ─────────────────────────────────────────────────────

export async function getUserAI(ctx: HandlerCtx): Promise<AISettings> {
  const { rows } = await ctx.db.query(
    `SELECT provider, api_key, default_model, base_url, user_id
       FROM plannen.user_settings
      WHERE user_id = $1 AND is_default = true
      LIMIT 1`,
    [ctx.userId],
  )
  if (rows.length === 0) throw new AIProviderNotConfigured()
  const r = rows[0]
  if (r.provider === 'anthropic' && !r.api_key) throw new AIProviderNotConfigured()
  return {
    provider: r.provider as Provider,
    api_key: r.api_key ?? null,
    default_model: r.default_model ?? null,
    base_url: r.base_url ?? null,
    user_id: r.user_id,
  }
}

async function recordUsage(ctx: HandlerCtx, ok: boolean, code: AIErrorCode | null) {
  const nowIso = new Date().toISOString()
  if (ok) {
    await ctx.db.query(
      `UPDATE plannen.user_settings
          SET last_used_at = $2,
              last_error_at = NULL,
              last_error_code = NULL
        WHERE user_id = $1 AND is_default = true`,
      [ctx.userId, nowIso],
    )
  } else {
    await ctx.db.query(
      `UPDATE plannen.user_settings
          SET last_error_at = $2,
              last_error_code = $3
        WHERE user_id = $1 AND is_default = true`,
      [ctx.userId, nowIso, code],
    )
  }
}

// ── Provider dispatch (Node tree — Tier 0) ─────────────────────────────────────

function providerFor(s: AISettings): AIProvider {
  switch (s.provider) {
    case 'anthropic':
      return anthropicProvider(s)
    case 'claude-code-cli':
      return claudeCliProvider(s)
    default: {
      const _exhaustive: never = s.provider
      throw new AIError('no_provider_configured', `Unsupported provider: ${String(_exhaustive)}`)
    }
  }
}

// ── Error normalisation (Anthropic SDK shapes; CLI provider pre-normalises) ────

function normaliseError(err: unknown): AIError {
  if (err instanceof AIError) return err
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status = typeof e?.statusCode === 'number'
    ? e.statusCode
    : typeof e?.status === 'number'
      ? e.status
      : null
  const lowered = message.toLowerCase()

  if (status === 401 || lowered.includes('invalid api key') || lowered.includes('authentication_error')) {
    return new AIError('invalid_api_key', 'AI provider rejected the API key.', { status: 400 })
  }
  if (status === 429 || lowered.includes('rate_limit') || lowered.includes('rate limit')) {
    const retryAfterRaw = e?.responseHeaders?.['retry-after'] ?? e?.headers?.['retry-after']
    const retryAfter = retryAfterRaw ? Number.parseInt(String(retryAfterRaw), 10) : 5
    return new AIError('rate_limited', 'AI provider rate-limited.', {
      status: 429,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 5,
    })
  }
  if (status === 404 || lowered.includes('model_not_found') || lowered.includes('does not have access')) {
    return new AIError('model_unavailable', 'Model not available for this account.', { status: 400 })
  }
  if (status && status >= 500) {
    return new AIError('provider_unavailable', 'AI provider unavailable.', { status: 502 })
  }
  return new AIError('unknown_error', 'Unexpected AI provider error.', { status: 500 })
}

async function withRetryAndTracking<T>(
  ctx: HandlerCtx,
  _s: AISettings,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn()
    await recordUsage(ctx, true, null)
    return result
  } catch (err) {
    const normalised = normaliseError(err)
    if (normalised.code === 'rate_limited') {
      const wait = (normalised.retryAfterSeconds ?? 5) * 1000
      await new Promise((r) => setTimeout(r, wait))
      try {
        const result = await fn()
        await recordUsage(ctx, true, null)
        return result
      } catch (retryErr) {
        const finalErr = normaliseError(retryErr)
        await recordUsage(ctx, false, finalErr.code)
        throw finalErr
      }
    }
    await recordUsage(ctx, false, normalised.code)
    throw normalised
  }
}

// ── Public call shapes ─────────────────────────────────────────────────────────

export async function generate(ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, () => providerFor(s).generate(ctx, opts))
}

export async function generateStructured<T>(ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, () => providerFor(s).generateStructured(ctx, opts))
}

export async function generateFromImage(ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, () => providerFor(s).generateFromImage(ctx, opts))
}

// ── Helpers (used by providers) ────────────────────────────────────────────────

export function parseJsonAgainstSchema<T>(raw: string, schema: z.ZodSchema<T>): T {
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const objMatch = text.match(/[\[{][\s\S]*[\]}]/)
  if (objMatch) text = objMatch[0]
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new AIError('unknown_error', `Failed to parse AI response as JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const validated = schema.safeParse(parsed)
  if (!validated.success) {
    throw new AIError('unknown_error', `AI response did not match schema: ${validated.error.message}`)
  }
  return validated.data
}

export function aiErrorResponse(err: unknown, corsHeaders: Record<string, string>): Response {
  const e = err instanceof AIError ? err : normaliseError(err)
  const body: Record<string, unknown> = {
    success: false,
    error: e.code,
    message: e.message,
  }
  if (e.retryAfterSeconds != null) body.retry_after = e.retryAfterSeconds
  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
