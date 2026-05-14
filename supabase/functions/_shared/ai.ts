// BYOK AI wrapper. Drops supabase-js; takes a `db` client + userId from the
// caller (Deno entry verifies JWT; Node entry resolves the user at boot).
//
// Public surface: getUserAI, generate, generateStructured, generateFromImage,
// aiErrorResponse, AIError, AIProviderNotConfigured.
//
// This file still runs in Deno on Tier 1 — it keeps `npm:` specifiers for the
// AI SDK and zod. The handlers extracted in later tasks import this module
// from Deno entry points. The Node backend's `/functions/v1/*` routes copy
// the source via the build step.
//
// V1 supports Anthropic only; the schema and switch are multi-provider so V1.1
// can add Gemini / OpenAI / Ollama / OpenAI-compatible without breaking changes.

import { generateText, generateObject, type LanguageModelV1 } from 'npm:ai@4'
import { createAnthropic, anthropic } from 'npm:@ai-sdk/anthropic@1'
import { z } from 'npm:zod@3'
import type { HandlerCtx } from './handlers/types.ts'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

export type Provider = 'anthropic' // V1.1 widens

export type AISettings = {
  provider: Provider
  api_key: string
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

// Read the calling user's default provider settings via the supplied db client.
// Throws AIProviderNotConfigured if no row exists.
export async function getUserAI(ctx: HandlerCtx): Promise<AISettings> {
  const { rows } = await ctx.db.query(
    `SELECT provider, api_key, default_model, base_url, user_id
       FROM plannen.user_settings
      WHERE user_id = $1 AND is_default = true
      LIMIT 1`,
    [ctx.userId],
  )
  if (rows.length === 0 || !rows[0].api_key) throw new AIProviderNotConfigured()
  const r = rows[0]
  return {
    provider: r.provider as Provider,
    api_key: r.api_key,
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

// ── Model + tool plumbing ──────────────────────────────────────────────────────

export function buildModel(s: AISettings, modelOverride?: string): LanguageModelV1 {
  const model = modelOverride ?? s.default_model ?? DEFAULT_ANTHROPIC_MODEL
  switch (s.provider) {
    case 'anthropic': {
      const provider = createAnthropic({ apiKey: s.api_key })
      return provider(model)
    }
    default: {
      // Exhaustiveness guard for future providers.
      const _exhaustive: never = s.provider
      throw new AIError('no_provider_configured', `Unsupported provider: ${_exhaustive}`)
    }
  }
}

function buildTools(s: AISettings, requested: ReadonlyArray<string> | undefined) {
  if (!requested?.length) return undefined
  const tools: Record<string, unknown> = {}
  for (const name of requested) {
    if (name === 'web_search') {
      if (s.provider === 'anthropic') {
        tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 5 })
      }
      // V1.1: provider-specific search tool here
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

// ── Error normalisation ────────────────────────────────────────────────────────

function normaliseError(err: unknown): AIError {
  if (err instanceof AIError) return err
  const message = err instanceof Error ? err.message : String(err)

  // Anthropic SDK status codes surface in the message; the AI SDK also exposes
  // them on APICallError. Probe both shapes.
  // deno-lint-ignore no-explicit-any
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

export async function generate(
  ctx: HandlerCtx,
  opts: { prompt: string; model?: string; tools?: ReadonlyArray<string>; maxTokens?: number },
): Promise<string> {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, async () => {
    const result = await generateText({
      model: buildModel(s, opts.model),
      prompt: opts.prompt,
      // deno-lint-ignore no-explicit-any
      tools: buildTools(s, opts.tools) as any,
      maxTokens: opts.maxTokens ?? 4096,
    })
    return result.text
  })
}

export async function generateStructured<T>(
  ctx: HandlerCtx,
  opts: {
    prompt: string
    schema: z.ZodSchema<T>
    model?: string
    tools?: ReadonlyArray<string>
    maxTokens?: number
  },
): Promise<T> {
  const s = await getUserAI(ctx)

  // Anthropic web_search isn't compatible with generateObject's tool-call-based
  // structured output. When tools are requested, fall back to generateText with
  // a JSON instruction and parse against the schema.
  if (opts.tools?.length) {
    return withRetryAndTracking(ctx, s, async () => {
      const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
      const result = await generateText({
        model: buildModel(s, opts.model),
        prompt: opts.prompt + jsonInstruction,
        // deno-lint-ignore no-explicit-any
        tools: buildTools(s, opts.tools) as any,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return parseJsonAgainstSchema(result.text, opts.schema)
    })
  }

  return withRetryAndTracking(ctx, s, async () => {
    const result = await generateObject({
      model: buildModel(s, opts.model),
      prompt: opts.prompt,
      schema: opts.schema,
      maxTokens: opts.maxTokens ?? 4096,
    })
    return result.object
  })
}

export async function generateFromImage(
  ctx: HandlerCtx,
  opts: { imageBytes: Uint8Array; mimeType: string; prompt: string; model?: string; maxTokens?: number },
): Promise<string> {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, async () => {
    const result = await generateText({
      model: buildModel(s, opts.model),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: opts.imageBytes, mimeType: opts.mimeType },
            { type: 'text', text: opts.prompt },
          ],
        },
      ],
      maxTokens: opts.maxTokens ?? 2048,
    })
    return result.text
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseJsonAgainstSchema<T>(raw: string, schema: z.ZodSchema<T>): T {
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

// Helper for edge functions: turn an AIError into a CORS-aware Response.
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
