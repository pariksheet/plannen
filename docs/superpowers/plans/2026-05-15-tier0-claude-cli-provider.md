# Tier-0 `claude -p` AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-code-cli` AI provider that lets Tier-0 Plannen users run backend AI calls (Discovery, source analysis, image extraction, story-writing) through their locally installed Claude Code subprocess instead of needing a separate Anthropic console API key.

**Architecture:** Refactor `_shared/ai.ts` (both Node and Deno trees) to dispatch via an internal `AIProvider` interface. Extract the existing Anthropic logic to `providers/anthropic.ts` (both trees). Add a Node-only `providers/claude-cli.ts` that shells out to `claude -p --output-format=json` via an injected `runCli` helper. Boot-time detection of the `claude` binary auto-configures the CLI provider as default if no existing settings row exists. Tier-1 (Deno edge functions) cannot shell out and stays BYOK — the CLI provider files are physically absent from the Deno tree.

**Tech Stack:** TypeScript (Hono + vitest on Node side; Deno test runner on Deno side), Node `child_process.spawn`, Vercel AI SDK (`ai@4`, `@ai-sdk/anthropic@1`), zod, PostgreSQL via `pg.Pool`.

**Spec:** [`docs/superpowers/specs/2026-05-15-tier0-claude-cli-provider-design.md`](../specs/2026-05-15-tier0-claude-cli-provider-design.md)

---

## File Structure

**Both trees** (`backend/src/_shared/` and `supabase/functions/_shared/`):

```
ai.ts                      # SHRUNK: dispatcher only (~120 lines)
providers/
  types.ts                 # NEW: AIProvider interface, GenerateOpts, etc.
  anthropic.ts             # NEW: AnthropicProvider impl (extracted from ai.ts)
```

**Node tree only** (`backend/src/_shared/`):

```
providers/
  run-cli.ts               # NEW: child_process wrapper with timeout/kill
  claude-cli.ts            # NEW: ClaudeCliProvider (subprocess shim)
cliDetection.ts            # NEW: cached `claude --version` probe + parseVersion
```

**Other Node files modified:**

```
backend/src/index.ts                   # invoke boot probe + maybeAutoConfigureCliProvider
backend/src/routes/api/settings.ts     # GET /api/settings/system + PATCH validation
```

**Web tree** (React + Vite, project-root `src/`):

```
src/context/SettingsContext.tsx        # widen Provider union; thread through cliAvailable
src/components/Settings.tsx            # provider dropdown w/ CLI option + UI conditionals
src/lib/dbClient.ts                    # add settings.system() helper for new endpoint
```

**NOT modified:** `scripts/bootstrap.sh` already writes `PLANNEN_TIER` to `.env` at line 251.

---

## Phase 1 — Refactor to AIProvider interface (no behaviour change)

These tasks introduce the abstraction layer without changing observable behaviour. After Phase 1, all existing tests pass and AI features work exactly as today.

### Task 1: Create `providers/types.ts` in both trees

**Files:**
- Create: `backend/src/_shared/providers/types.ts`
- Create: `supabase/functions/_shared/providers/types.ts`

- [ ] **Step 1: Create the Node version**

`backend/src/_shared/providers/types.ts`:

```ts
import { z } from 'zod'
import type { HandlerCtx } from '../handlers/types.js'

export type Provider = 'anthropic' | 'claude-code-cli'

export type GenerateOpts = {
  prompt: string
  model?: string
  tools?: ReadonlyArray<'web_search'>
  maxTokens?: number
}

export type GenerateStructuredOpts<T> = GenerateOpts & { schema: z.ZodSchema<T> }

export type GenerateFromImageOpts = {
  imageBytes: Uint8Array
  mimeType: string
  prompt: string
  model?: string
  maxTokens?: number
}

export interface AIProvider {
  generate(ctx: HandlerCtx, opts: GenerateOpts): Promise<string>
  generateStructured<T>(ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T>
  generateFromImage(ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string>
}
```

- [ ] **Step 2: Create the Deno version (identical except import specifiers)**

`supabase/functions/_shared/providers/types.ts`:

```ts
import { z } from 'npm:zod@3'
import type { HandlerCtx } from '../handlers/types.ts'

export type Provider = 'anthropic' | 'claude-code-cli'

export type GenerateOpts = {
  prompt: string
  model?: string
  tools?: ReadonlyArray<'web_search'>
  maxTokens?: number
}

export type GenerateStructuredOpts<T> = GenerateOpts & { schema: z.ZodSchema<T> }

export type GenerateFromImageOpts = {
  imageBytes: Uint8Array
  mimeType: string
  prompt: string
  model?: string
  maxTokens?: number
}

export interface AIProvider {
  generate(ctx: HandlerCtx, opts: GenerateOpts): Promise<string>
  generateStructured<T>(ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T>
  generateFromImage(ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string>
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: PASS (no usages yet, file just adds types)

- [ ] **Step 4: Commit**

```bash
git add backend/src/_shared/providers/types.ts supabase/functions/_shared/providers/types.ts
git commit -m "ai: introduce AIProvider interface + shared option types"
```

---

### Task 2: Extract Anthropic provider to `providers/anthropic.ts` (both trees)

The current `ai.ts` contains `buildModel`, `buildTools`, and three top-level functions (`generate`, `generateStructured`, `generateFromImage`) that all use the AI SDK directly. This task moves the Anthropic-specific code into a provider while keeping the public surface of `ai.ts` unchanged in this task — the dispatcher refactor in Task 3 wires it up.

**Files:**
- Create: `backend/src/_shared/providers/anthropic.ts`
- Create: `supabase/functions/_shared/providers/anthropic.ts`

- [ ] **Step 1: Create Node version**

`backend/src/_shared/providers/anthropic.ts`:

```ts
import { generateText, generateObject, type LanguageModelV1 } from 'ai'
import { createAnthropic, anthropic } from '@ai-sdk/anthropic'
import type { HandlerCtx } from '../handlers/types.js'
import type { AISettings } from '../ai.js'
import { AIError, parseJsonAgainstSchema } from '../ai.js'
import type { AIProvider, GenerateOpts, GenerateStructuredOpts, GenerateFromImageOpts } from './types.js'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

function buildModel(s: AISettings, modelOverride?: string): LanguageModelV1 {
  const model = modelOverride ?? s.default_model ?? DEFAULT_ANTHROPIC_MODEL
  const provider = createAnthropic({ apiKey: s.api_key })
  return provider(model)
}

function buildTools(requested: ReadonlyArray<string> | undefined) {
  if (!requested?.length) return undefined
  const tools: Record<string, unknown> = {}
  for (const name of requested) {
    if (name === 'web_search') {
      const factory = (anthropic.tools as unknown as Record<string, ((opts: { maxUses: number }) => unknown) | undefined>)
        .webSearch_20250305
      if (typeof factory === 'function') tools.web_search = factory({ maxUses: 5 })
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

export function anthropicProvider(s: AISettings): AIProvider {
  return {
    async generate(_ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
      const result = await generateText({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: buildTools(opts.tools) as any,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.text
    },

    async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
      if (opts.tools?.length) {
        const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
        const result = await generateText({
          model: buildModel(s, opts.model),
          prompt: opts.prompt + jsonInstruction,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: buildTools(opts.tools) as any,
          maxTokens: opts.maxTokens ?? 4096,
        })
        return parseJsonAgainstSchema(result.text, opts.schema)
      }
      const result = await generateObject({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        schema: opts.schema,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.object
    },

    async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
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
    },
  }
}
```

- [ ] **Step 2: Create Deno version (identical except import specifiers)**

`supabase/functions/_shared/providers/anthropic.ts`:

```ts
import { generateText, generateObject, type LanguageModelV1 } from 'npm:ai@4'
import { createAnthropic, anthropic } from 'npm:@ai-sdk/anthropic@1'
import type { HandlerCtx } from '../handlers/types.ts'
import type { AISettings } from '../ai.ts'
import { AIError, parseJsonAgainstSchema } from '../ai.ts'
import type { AIProvider, GenerateOpts, GenerateStructuredOpts, GenerateFromImageOpts } from './types.ts'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

function buildModel(s: AISettings, modelOverride?: string): LanguageModelV1 {
  const model = modelOverride ?? s.default_model ?? DEFAULT_ANTHROPIC_MODEL
  const provider = createAnthropic({ apiKey: s.api_key })
  return provider(model)
}

function buildTools(requested: ReadonlyArray<string> | undefined) {
  if (!requested?.length) return undefined
  const tools: Record<string, unknown> = {}
  for (const name of requested) {
    if (name === 'web_search') {
      const factory = (anthropic.tools as unknown as Record<string, ((opts: { maxUses: number }) => unknown) | undefined>)
        .webSearch_20250305
      if (typeof factory === 'function') tools.web_search = factory({ maxUses: 5 })
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

export function anthropicProvider(s: AISettings): AIProvider {
  return {
    async generate(_ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
      const result = await generateText({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        // deno-lint-ignore no-explicit-any
        tools: buildTools(opts.tools) as any,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.text
    },

    async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
      if (opts.tools?.length) {
        const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
        const result = await generateText({
          model: buildModel(s, opts.model),
          prompt: opts.prompt + jsonInstruction,
          // deno-lint-ignore no-explicit-any
          tools: buildTools(opts.tools) as any,
          maxTokens: opts.maxTokens ?? 4096,
        })
        return parseJsonAgainstSchema(result.text, opts.schema)
      }
      const result = await generateObject({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        schema: opts.schema,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.object
    },

    async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
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
    },
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/_shared/providers/anthropic.ts supabase/functions/_shared/providers/anthropic.ts
git commit -m "ai: extract AnthropicProvider from ai.ts dispatcher"
```

---

### Task 3: Refactor `ai.ts` dispatcher in both trees

Now we wire up the new abstraction. `ai.ts` keeps `getUserAI`, `AIError`, `AIProviderNotConfigured`, `withRetryAndTracking`, `normaliseError`, `parseJsonAgainstSchema`, and `aiErrorResponse` — these are dispatcher-level concerns. The three top-level functions become thin wrappers that delegate to a provider.

**Files:**
- Modify: `backend/src/_shared/ai.ts` (entire file rewritten — see Step 1)
- Modify: `supabase/functions/_shared/ai.ts` (entire file rewritten — see Step 2)

- [ ] **Step 1: Replace Node `ai.ts` contents**

```ts
// BYOK AI dispatcher. Routes calls to a per-provider implementation (Anthropic
// today; claude-code-cli on Tier 0 — see providers/).
//
// Public surface: getUserAI, generate, generateStructured, generateFromImage,
// aiErrorResponse, AIError, AIProviderNotConfigured, parseJsonAgainstSchema.

import { z } from 'zod'
import type { HandlerCtx } from './handlers/types.js'
import type { AIProvider, GenerateOpts, GenerateStructuredOpts, GenerateFromImageOpts, Provider } from './providers/types.js'
import { anthropicProvider } from './providers/anthropic.js'
import { claudeCliProvider } from './providers/claude-cli.js'

export type { Provider } from './providers/types.js'

export type AISettings = {
  provider: Provider
  api_key: string | null     // null for claude-code-cli; string for anthropic
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
  // CLI provider rows have api_key = NULL by design; only anthropic requires it.
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
          SET last_used_at = $2, last_error_at = NULL, last_error_code = NULL
        WHERE user_id = $1 AND is_default = true`,
      [ctx.userId, nowIso],
    )
  } else {
    await ctx.db.query(
      `UPDATE plannen.user_settings
          SET last_error_at = $2, last_error_code = $3
        WHERE user_id = $1 AND is_default = true`,
      [ctx.userId, nowIso, code],
    )
  }
}

// ── Provider dispatch ──────────────────────────────────────────────────────────

function providerFor(s: AISettings): AIProvider {
  switch (s.provider) {
    case 'anthropic':       return anthropicProvider(s)
    case 'claude-code-cli': return claudeCliProvider(s)
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
  const status = typeof e?.statusCode === 'number' ? e.statusCode
    : typeof e?.status === 'number' ? e.status : null
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
  const body: Record<string, unknown> = { success: false, error: e.code, message: e.message }
  if (e.retryAfterSeconds != null) body.retry_after = e.retryAfterSeconds
  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
```

**Note:** This file imports `claudeCliProvider` from `./providers/claude-cli.js` — that file doesn't exist yet. Task 3 will fail typecheck until Task 7 lands. To avoid blocking, **temporarily stub** the import at the top:

```ts
// Temporary stub until Task 7 lands. Throws if invoked (no row should reference
// claude-code-cli before onboarding wires it).
const claudeCliProvider = (_s: AISettings): AIProvider => ({
  generate: () => { throw new AIError('no_provider_configured', 'CLI provider not wired yet') },
  generateStructured: () => { throw new AIError('no_provider_configured', 'CLI provider not wired yet') },
  generateFromImage: () => { throw new AIError('no_provider_configured', 'CLI provider not wired yet') },
})
```

Replace this stub with the real import in Task 8.

- [ ] **Step 2: Replace Deno `ai.ts` contents**

Same structure but with Deno import specifiers and an unconditional defensive throw for the `claude-code-cli` case (no stub needed — Deno tree never gets the real provider). Use this `providerFor`:

```ts
function providerFor(s: AISettings): AIProvider {
  switch (s.provider) {
    case 'anthropic':       return anthropicProvider(s)
    case 'claude-code-cli': throw new AIError('no_provider_configured',
                              'claude-code-cli is not available in Tier 1 edge functions.')
    default: {
      const _exhaustive: never = s.provider
      throw new AIError('no_provider_configured', `Unsupported provider: ${String(_exhaustive)}`)
    }
  }
}
```

Imports in the Deno copy use `npm:zod@3`, `'./handlers/types.ts'`, `'./providers/anthropic.ts'`, `'./providers/types.ts'`. Do NOT import `./providers/claude-cli.ts` — that file does not exist in the Deno tree.

The rest of the file (AISettings, AIError, AIProviderNotConfigured, getUserAI, recordUsage, normaliseError, withRetryAndTracking, generate/generateStructured/generateFromImage, parseJsonAgainstSchema, aiErrorResponse) is identical to the Node version with `.ts` extensions on relative imports.

- [ ] **Step 3: Run all Node tests to confirm no regression**

Run: `cd backend && npm test`
Expected: PASS — all existing handler tests, settings tests, etc., pass unchanged. Provider switch is transparent.

- [ ] **Step 4: Run all Deno tests to confirm no regression**

Run: `cd supabase/functions && deno test --allow-all` (or whatever the existing Deno test command is — check `package.json` scripts or `Makefile`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/ai.ts supabase/functions/_shared/ai.ts
git commit -m "ai: refactor dispatcher to delegate via AIProvider interface

Behavioural no-op. Public surface unchanged. Anthropic logic now lives
in providers/anthropic.ts; ai.ts owns dispatch, retry, and shared helpers."
```

---

## Phase 2 — CLI provider plumbing (Node only)

### Task 4: Create `providers/run-cli.ts` (subprocess wrapper)

**Files:**
- Create: `backend/src/_shared/providers/run-cli.ts`
- Create: `backend/src/_shared/providers/run-cli.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/src/_shared/providers/run-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defaultRunCli } from './run-cli.js'

describe('defaultRunCli', () => {
  it('returns stdout and exit 0 on success', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.stdout.write("hello")'], { timeoutMs: 5_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello')
  })

  it('returns non-zero exit code without throwing', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.exit(3)'], { timeoutMs: 5_000 })
    expect(r.exitCode).toBe(3)
  })

  it('throws with code ENOENT when binary missing', async () => {
    await expect(defaultRunCli('this-binary-does-not-exist-xyz', [], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws with code ETIMEDOUT when subprocess exceeds timeout', async () => {
    await expect(defaultRunCli('node', ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('forwards optional stdin input', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.stdin.pipe(process.stdout)'], {
      timeoutMs: 5_000, input: 'from-stdin',
    })
    expect(r.stdout).toBe('from-stdin')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd backend && npx vitest run src/_shared/providers/run-cli.test.ts`
Expected: FAIL — "Cannot find module './run-cli.js'"

- [ ] **Step 3: Implement `run-cli.ts`**

`backend/src/_shared/providers/run-cli.ts`:

```ts
import { spawn } from 'node:child_process'

export type RunCliResult = { stdout: string; stderr: string; exitCode: number }
export type RunCliOpts = { timeoutMs: number; input?: string }
export type RunCli = (cmd: string, args: string[], opts: RunCliOpts) => Promise<RunCliResult>

class RunCliError extends Error {
  code: 'ENOENT' | 'ETIMEDOUT' | 'UNKNOWN'
  constructor(code: 'ENOENT' | 'ETIMEDOUT' | 'UNKNOWN', message: string) {
    super(message)
    this.name = 'RunCliError'
    this.code = code
  }
}

export const defaultRunCli: RunCli = (cmd, args, opts) =>
  new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    const timeout = setTimeout(() => {
      if (settled) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 5_000)
      settled = true
      reject(new RunCliError('ETIMEDOUT', `Subprocess timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (err.code === 'ENOENT') {
        reject(new RunCliError('ENOENT', `Binary not found: ${cmd}`))
      } else {
        reject(new RunCliError('UNKNOWN', err.message))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })

    if (opts.input != null) {
      child.stdin.write(opts.input)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && npx vitest run src/_shared/providers/run-cli.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/providers/run-cli.ts backend/src/_shared/providers/run-cli.test.ts
git commit -m "ai/cli: add runCli subprocess wrapper with timeout + ENOENT handling"
```

---

### Task 5: Create `providers/claude-cli.ts` — happy-path generate

This task implements the core flow with one test case. Subsequent tasks layer on the other 8 cases.

**Files:**
- Create: `backend/src/_shared/providers/claude-cli.ts`
- Create: `backend/src/_shared/providers/claude-cli.test.ts`

- [ ] **Step 1: Write failing test (happy-path generate)**

`backend/src/_shared/providers/claude-cli.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeClaudeCliProvider } from './claude-cli.js'
import type { RunCli } from './run-cli.js'
import type { AISettings } from '../ai.js'

const settings: AISettings = {
  provider: 'claude-code-cli',
  api_key: null,
  default_model: null,
  base_url: null,
  user_id: 'test-user',
}

// Minimal fake HandlerCtx for tests — provider methods don't use ctx.db.
const ctx = { userId: 'test-user', db: {} } as any

function makeRunCli(stub: (cmd: string, args: string[]) => { stdout: string; stderr?: string; exitCode?: number }): RunCli {
  return async (cmd, args, _opts) => ({
    stdout: stub(cmd, args).stdout,
    stderr: stub(cmd, args).stderr ?? '',
    exitCode: stub(cmd, args).exitCode ?? 0,
  })
}

describe('claudeCliProvider.generate', () => {
  it('returns wrapper.result on success', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: 'hello world', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    const out = await provider.generate(ctx, { prompt: 'say hi' })
    expect(out).toBe('hello world')
    expect(runCli).toHaveBeenCalledWith(
      'claude',
      ['-p', '--output-format=json', 'say hi'],
      expect.objectContaining({ timeoutMs: 90_000 }),
    )
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: FAIL — "Cannot find module './claude-cli.js'"

- [ ] **Step 3: Implement minimal provider for the happy path**

`backend/src/_shared/providers/claude-cli.ts`:

```ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { HandlerCtx } from '../handlers/types.js'
import type { AISettings } from '../ai.js'
import { AIError, parseJsonAgainstSchema } from '../ai.js'
import type { AIProvider, GenerateOpts, GenerateStructuredOpts, GenerateFromImageOpts } from './types.js'
import type { RunCli } from './run-cli.js'
import { defaultRunCli } from './run-cli.js'

const DEFAULT_TIMEOUT_MS = 90_000

export function makeClaudeCliProvider(deps: {
  runCli?: RunCli
  tmpDir?: () => string
  uuid?: () => string
  binary?: string
} = {}): (s: AISettings) => AIProvider {
  const runCli = deps.runCli ?? defaultRunCli
  const tmp = deps.tmpDir ?? tmpdir
  const uuid = deps.uuid ?? randomUUID
  const binary = deps.binary ?? 'claude'

  return (_s: AISettings): AIProvider => ({
    async generate(_ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
      const args = ['-p', '--output-format=json']
      if (opts.tools?.includes('web_search')) args.push('--allowed-tools', 'WebSearch')
      args.push(opts.prompt)
      const result = await invokeCli(runCli, binary, args)
      return result.result
    },

    async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
      throw new AIError('unknown_error', 'not implemented yet')   // Task 6
    },

    async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
      throw new AIError('unknown_error', 'not implemented yet')   // Task 7
    },
  })
}

// Convenience export: provider factory with production defaults baked in.
export const claudeCliProvider = makeClaudeCliProvider()

// ── Internals ──────────────────────────────────────────────────────────────────

async function invokeCli(runCli: RunCli, binary: string, args: string[]): Promise<{ result: string }> {
  let res
  try {
    res = await runCli(binary, args, { timeoutMs: DEFAULT_TIMEOUT_MS })
  } catch (e) {
    throw mapRunCliError(e)
  }
  return unwrapClaudeJson(res.stdout, res.stderr, res.exitCode)
}

function mapRunCliError(e: unknown): AIError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (e as any)?.code
  if (code === 'ENOENT') {
    return new AIError('no_provider_configured',
      'Claude CLI not found in PATH — install Claude Code or switch to BYOK in /settings.')
  }
  if (code === 'ETIMEDOUT') {
    return new AIError('provider_unavailable', `claude subprocess timed out.`)
  }
  return new AIError('unknown_error',
    `claude subprocess failed: ${e instanceof Error ? e.message : String(e)}`)
}

function unwrapClaudeJson(stdout: string, stderr: string, exitCode: number): { result: string } {
  if (exitCode !== 0) {
    throw new AIError('provider_unavailable', `claude exited ${exitCode}: ${truncate(stderr, 500)}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wrapper: any
  try { wrapper = JSON.parse(stdout) }
  catch { throw new AIError('unknown_error', `claude output unparseable: ${truncate(stdout, 200)}`) }

  if (wrapper.is_error === true || wrapper.subtype === 'error') throw mapClaudeError(wrapper)
  if (typeof wrapper.result !== 'string') {
    throw new AIError('unknown_error', 'claude wrapper missing .result string — format may have changed')
  }
  return { result: wrapper.result }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapClaudeError(wrapper: any): AIError {
  const msg = String(wrapper?.message ?? wrapper?.error ?? 'claude returned error wrapper')
  const lowered = msg.toLowerCase()
  if (/log in|authenticate|not authenticated/.test(lowered)) {
    return new AIError('invalid_api_key', 'Run `claude` in your terminal to log in.')
  }
  if (/rate|limit|quota|credit/.test(lowered)) {
    const retryAfter = Number(wrapper?.retry_after) || 60
    return new AIError('rate_limited', msg, { retryAfterSeconds: retryAfter })
  }
  return new AIError('provider_unavailable', msg)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: PASS — happy-path generate.

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/providers/claude-cli.ts backend/src/_shared/providers/claude-cli.test.ts
git commit -m "ai/cli: claude-code-cli provider (happy-path generate)"
```

---

### Task 6: Add `generateStructured` to CLI provider

**Files:**
- Modify: `backend/src/_shared/providers/claude-cli.ts`
- Modify: `backend/src/_shared/providers/claude-cli.test.ts`

- [ ] **Step 1: Add failing tests for generateStructured**

Append to `claude-cli.test.ts`:

```ts
import { z } from 'zod'

describe('claudeCliProvider.generateStructured', () => {
  const schema = z.object({ city: z.string(), days: z.number() })

  it('parses JSON from wrapper.result and validates against schema', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({
        result: '```json\n{"city": "Brussels", "days": 3}\n```',
        is_error: false,
      }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    const out = await provider.generateStructured(ctx, { prompt: 'pick a city', schema })
    expect(out).toEqual({ city: 'Brussels', days: 3 })
    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('-p')
    expect(calledArgs).toContain('--output-format=json')
    // JSON instruction appended to prompt
    expect(calledArgs[calledArgs.length - 1]).toMatch(/Return ONLY a JSON value/)
  })

  it('appends --allowed-tools WebSearch when tools include web_search', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"city": "Brussels", "days": 1}', is_error: false }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await provider.generateStructured(ctx, { prompt: 'search', schema, tools: ['web_search'] })
    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('--allowed-tools')
    expect(calledArgs).toContain('WebSearch')
  })

  it('throws unknown_error when wrapper.result does not match schema', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"city": "Brussels"}', is_error: false }),  // missing `days`
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generateStructured(ctx, { prompt: 'pick', schema }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: FAIL — `generateStructured` currently throws "not implemented yet".

- [ ] **Step 3: Implement `generateStructured` in `claude-cli.ts`**

Replace the stub body of `generateStructured` with:

```ts
async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
  const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
  const args = ['-p', '--output-format=json']
  if (opts.tools?.includes('web_search')) args.push('--allowed-tools', 'WebSearch')
  args.push(opts.prompt + jsonInstruction)
  const { result } = await invokeCli(runCli, binary, args)
  return parseJsonAgainstSchema(result, opts.schema)
},
```

- [ ] **Step 4: Run, verify tests pass**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: PASS — happy-path generate + 3 generateStructured cases.

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/providers/claude-cli.ts backend/src/_shared/providers/claude-cli.test.ts
git commit -m "ai/cli: implement generateStructured (JSON instruction + schema validation)"
```

---

### Task 7: Add `generateFromImage` to CLI provider

**Files:**
- Modify: `backend/src/_shared/providers/claude-cli.ts`
- Modify: `backend/src/_shared/providers/claude-cli.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `claude-cli.test.ts`:

```ts
describe('claudeCliProvider.generateFromImage', () => {
  it('writes temp file, calls claude with --allowed-tools Read and path in prompt, unlinks temp file', async () => {
    const writtenFiles = new Map<string, Buffer>()
    const unlinkedFiles: string[] = []

    // Mock fs via vi.mock at the top of the file (do this once for the whole test file).
    // For this test, we instead use a dep-injected tmpDir + uuid to control the path,
    // and rely on real fs (it can write to /tmp safely). After the call, check unlink ran.

    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: 'an image of a dog', is_error: false }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({
      runCli,
      tmpDir: () => '/tmp',
      uuid: () => 'fixed-uuid',
    })(settings)

    const out = await provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),  // PNG magic
      mimeType: 'image/png',
      prompt: 'what is this',
    })
    expect(out).toBe('an image of a dog')

    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('--allowed-tools')
    expect(calledArgs).toContain('Read')
    // Last arg is prompt-with-path
    const lastArg = calledArgs[calledArgs.length - 1]
    expect(lastArg).toContain('/tmp/plannen-img-fixed-uuid.png')
    expect(lastArg).toContain('what is this')

    // Temp file should not exist after the call.
    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/plannen-img-fixed-uuid.png')).rejects.toThrow()
  })

  it('throws unknown_error on unsupported mime type', async () => {
    const runCli = vi.fn<RunCli>()
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([]),
      mimeType: 'image/svg+xml',
      prompt: 'x',
    })).rejects.toMatchObject({ code: 'unknown_error' })
    expect(runCli).not.toHaveBeenCalled()
  })

  it('unlinks temp file even when subprocess fails', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'not json', stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({
      runCli,
      tmpDir: () => '/tmp',
      uuid: () => 'fail-uuid',
    })(settings)
    await expect(provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([0x89, 0x50]),
      mimeType: 'image/jpeg',
      prompt: 'x',
    })).rejects.toMatchObject({ code: 'unknown_error' })
    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/plannen-img-fail-uuid.jpg')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: FAIL — stub throws "not implemented yet".

- [ ] **Step 3: Implement `generateFromImage` in `claude-cli.ts`**

Replace the stub:

```ts
async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
  const ext = extForMimeType(opts.mimeType)
  if (!ext) {
    throw new AIError('unknown_error', `Unsupported image type for CLI provider: ${opts.mimeType}`)
  }
  const path = join(tmp(), `plannen-img-${uuid()}.${ext}`)
  await writeFile(path, opts.imageBytes)
  try {
    const args = [
      '-p', '--output-format=json',
      '--allowed-tools', 'Read',
      `Analyze the image at ${path}:\n\n${opts.prompt}`,
    ]
    const { result } = await invokeCli(runCli, binary, args)
    return result
  } finally {
    await unlink(path).catch(() => { /* best-effort */ })
  }
},
```

And add the helper at the bottom of the file:

```ts
function extForMimeType(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case 'image/png':  return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif':  return 'gif'
    default: return null
  }
}
```

- [ ] **Step 4: Run, verify tests pass**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: PASS — all 7 tests so far.

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/providers/claude-cli.ts backend/src/_shared/providers/claude-cli.test.ts
git commit -m "ai/cli: implement generateFromImage via temp file + --allowed-tools Read"
```

---

### Task 8: Add error-mapping test coverage to CLI provider

**Files:**
- Modify: `backend/src/_shared/providers/claude-cli.test.ts` (only — implementation already in place)

- [ ] **Step 1: Add the remaining error-path tests**

Append to `claude-cli.test.ts`:

```ts
describe('claudeCliProvider error mapping', () => {
  it('ENOENT from runCli → no_provider_configured', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'no_provider_configured' })
  })

  it('ETIMEDOUT from runCli → provider_unavailable', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('non-zero exit code → provider_unavailable with stderr in message', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: '', stderr: 'boom', exitCode: 2,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'provider_unavailable', message: expect.stringContaining('boom') })
  })

  it('is_error wrapper with auth message → invalid_api_key', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: true, message: 'Please log in by running claude' }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_api_key' })
  })

  it('is_error wrapper with rate/credit message → rate_limited', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: true, message: 'Monthly credit exhausted', retry_after: 120 }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120 })
  })

  it('unparseable stdout JSON → unknown_error', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'this is not json', stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })

  it('wrapper missing .result string → unknown_error', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: false }), stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })
})
```

- [ ] **Step 2: Run, verify tests pass (implementation already covers these)**

Run: `cd backend && npx vitest run src/_shared/providers/claude-cli.test.ts`
Expected: PASS — all 14 tests (7 happy-path + 7 error-mapping).

- [ ] **Step 3: Commit**

```bash
git add backend/src/_shared/providers/claude-cli.test.ts
git commit -m "ai/cli: cover all 7 error-mapping branches with unit tests"
```

---

### Task 9: Wire `claudeCliProvider` into `ai.ts` dispatcher

Replace the stub from Task 3 with the real import.

**Files:**
- Modify: `backend/src/_shared/ai.ts`

- [ ] **Step 1: Remove the temporary stub block at the top of `ai.ts`**

Delete the stub:

```ts
// REMOVE THIS:
const claudeCliProvider = (_s: AISettings): AIProvider => ({ ... })
```

- [ ] **Step 2: Add the real import**

Near the top, alongside the `anthropicProvider` import:

```ts
import { claudeCliProvider } from './providers/claude-cli.js'
```

- [ ] **Step 3: Run all tests to confirm wiring works**

Run: `cd backend && npm test`
Expected: PASS — all existing tests still pass, CLI provider tests still pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/_shared/ai.ts
git commit -m "ai: wire real claudeCliProvider into dispatcher"
```

---

## Phase 3 — Detection + onboarding (Node only)

### Task 10: Create `cliDetection.ts`

**Files:**
- Create: `backend/src/_shared/cliDetection.ts`
- Create: `backend/src/_shared/cliDetection.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/src/_shared/cliDetection.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectClaudeCli, parseVersion, _resetDetectionCacheForTests } from './cliDetection.js'
import type { RunCli } from './providers/run-cli.js'

beforeEach(() => { _resetDetectionCacheForTests() })

describe('parseVersion', () => {
  it('extracts semver from version output', () => {
    expect(parseVersion('claude 1.2.3 (build abc)\n')).toBe('1.2.3')
  })
  it('returns null when no version present', () => {
    expect(parseVersion('claude (no version)')).toBeNull()
  })
})

describe('detectClaudeCli', () => {
  it('returns available=true on exit 0', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'claude 1.0.0\n', stderr: '', exitCode: 0,
    })
    const r = await detectClaudeCli(runCli)
    expect(r).toEqual({ available: true, version: '1.0.0' })
  })

  it('returns available=false on ENOENT', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const r = await detectClaudeCli(runCli)
    expect(r).toEqual({ available: false, version: null })
  })

  it('returns available=false on non-zero exit', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({ stdout: '', stderr: 'err', exitCode: 1 })
    const r = await detectClaudeCli(runCli)
    expect(r.available).toBe(false)
  })

  it('caches the result — second call does not re-probe', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'claude 1.0.0', stderr: '', exitCode: 0,
    })
    await detectClaudeCli(runCli)
    await detectClaudeCli(runCli)
    expect(runCli).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd backend && npx vitest run src/_shared/cliDetection.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `cliDetection.ts`**

`backend/src/_shared/cliDetection.ts`:

```ts
import type { RunCli } from './providers/run-cli.js'

export type CliDetection = { available: boolean; version: string | null }

let cached: CliDetection | null = null

export function parseVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? m[0] : null
}

export async function detectClaudeCli(runCli: RunCli): Promise<CliDetection> {
  if (cached) return cached
  try {
    const { stdout, exitCode } = await runCli('claude', ['--version'], { timeoutMs: 5_000 })
    cached = { available: exitCode === 0, version: parseVersion(stdout) }
  } catch {
    cached = { available: false, version: null }
  }
  return cached
}

// Exported for tests only.
export function _resetDetectionCacheForTests(): void { cached = null }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd backend && npx vitest run src/_shared/cliDetection.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/_shared/cliDetection.ts backend/src/_shared/cliDetection.test.ts
git commit -m "ai/cli: add cached claude --version boot probe"
```

---

### Task 11: Add `maybeAutoConfigureCliProvider` and wire into boot

**Files:**
- Create: `backend/src/_shared/maybeAutoConfigureCliProvider.ts`
- Create: `backend/src/_shared/maybeAutoConfigureCliProvider.test.ts`
- Modify: `backend/src/index.ts` (add boot call)

- [ ] **Step 1: Write failing tests**

`backend/src/_shared/maybeAutoConfigureCliProvider.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { pool } from '../db.js'
import { ensureTestUser, deleteTestUser } from '../routes/api/_testFixtures.js'
import { maybeAutoConfigureCliProvider } from './maybeAutoConfigureCliProvider.js'

const email = 'cli-autoconfig-test@plannen.local'
let userId: string

beforeAll(async () => { userId = await ensureTestUser(pool, email) })
afterEach(async () => {
  const c = await pool.connect()
  try { await c.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [userId]) }
  finally { c.release() }
})
afterAll(async () => { await deleteTestUser(pool, email) })

describe('maybeAutoConfigureCliProvider', () => {
  it('inserts a default claude-code-cli row when no settings exist', async () => {
    await maybeAutoConfigureCliProvider(pool, userId, '1.0.0')
    const { rows } = await pool.query(
      'SELECT provider, is_default, api_key FROM plannen.user_settings WHERE user_id = $1',
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'claude-code-cli',
      is_default: true,
      api_key: null,
    })
  })

  it('does NOT overwrite an existing default row', async () => {
    await pool.query(
      `INSERT INTO plannen.user_settings (user_id, provider, is_default, api_key)
       VALUES ($1, 'anthropic', true, 'sk-existing')`,
      [userId],
    )
    await maybeAutoConfigureCliProvider(pool, userId, '1.0.0')
    const { rows } = await pool.query(
      'SELECT provider, api_key FROM plannen.user_settings WHERE user_id = $1',
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'anthropic', api_key: 'sk-existing' })
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd backend && npx vitest run src/_shared/maybeAutoConfigureCliProvider.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`backend/src/_shared/maybeAutoConfigureCliProvider.ts`:

```ts
import type { Pool } from 'pg'

export async function maybeAutoConfigureCliProvider(
  pool: Pool,
  userId: string,
  version: string | null,
): Promise<void> {
  const existing = await pool.query(
    'SELECT id FROM plannen.user_settings WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId],
  )
  if (existing.rows.length > 0) return

  await pool.query(
    `INSERT INTO plannen.user_settings (user_id, provider, is_default, default_model, api_key, base_url)
     VALUES ($1, 'claude-code-cli', true, NULL, NULL, NULL)`,
    [userId],
  )
  // eslint-disable-next-line no-console
  console.log(`detected Claude CLI ${version ?? '(unknown version)'} — using your subscription for AI calls`)
}
```

- [ ] **Step 4: Wire into `backend/src/index.ts`**

After the `resolveUserAtBoot` line (line 45) and before `const app = new Hono(...)` (line 48), add:

```ts
import { detectClaudeCli } from './_shared/cliDetection.js'
import { defaultRunCli } from './_shared/providers/run-cli.js'
import { maybeAutoConfigureCliProvider } from './_shared/maybeAutoConfigureCliProvider.js'

// ... existing imports stay ...

const user = await resolveUserAtBoot(USER_EMAIL)
console.log(`resolved user: ${user.email} (${user.userId})`)

if (process.env.PLANNEN_TIER === '0') {
  const detection = await detectClaudeCli(defaultRunCli)
  if (detection.available) {
    await maybeAutoConfigureCliProvider(pool, user.userId, detection.version)
  }
}
```

- [ ] **Step 5: Run all tests, verify pass**

Run: `cd backend && npm test`
Expected: PASS — new tests + all existing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/_shared/maybeAutoConfigureCliProvider.ts backend/src/_shared/maybeAutoConfigureCliProvider.test.ts backend/src/index.ts
git commit -m "ai/cli: auto-configure claude-code-cli provider on first Tier-0 boot"
```

---

## Phase 4 — Settings API

### Task 12: Add `GET /api/settings/system` endpoint

**Files:**
- Modify: `backend/src/routes/api/settings.ts`
- Modify: `backend/src/routes/api/settings.test.ts`

- [ ] **Step 1: Add failing test**

Append to `settings.test.ts`:

```ts
describe('GET /api/settings/system', () => {
  it('returns tier and cliAvailable', async () => {
    const res = await app.request('/api/settings/system')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveProperty('tier')
    expect(body.data).toHaveProperty('cliAvailable')
    expect(typeof body.data.tier).toBe('number')
    expect(typeof body.data.cliAvailable).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd backend && npx vitest run src/routes/api/settings.test.ts`
Expected: FAIL — endpoint not found, returns 404.

- [ ] **Step 3: Implement endpoint**

Add at the top of `settings.ts` (after the existing imports):

```ts
import { detectClaudeCli } from '../../_shared/cliDetection.js'
import { defaultRunCli } from '../../_shared/providers/run-cli.js'
```

Add after `settings.get('/', ...)` block:

```ts
settings.get('/system', async (c) => {
  const tier = Number(process.env.PLANNEN_TIER ?? '0')
  const detection = await detectClaudeCli(defaultRunCli)
  return c.json({
    data: {
      tier,
      cliAvailable: tier === 0 && detection.available,
      cliVersion: detection.version,
    },
  })
})
```

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && npx vitest run src/routes/api/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api/settings.ts backend/src/routes/api/settings.test.ts
git commit -m "settings: add GET /api/settings/system (tier + CLI availability)"
```

---

### Task 13: Add CLI-provider validation to `PATCH /api/settings`

**Files:**
- Modify: `backend/src/routes/api/settings.ts`
- Modify: `backend/src/routes/api/settings.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `settings.test.ts`:

```ts
describe('PATCH /api/settings — CLI provider validation', () => {
  afterEach(async () => {
    const c = await pool.connect()
    try { await c.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [testUserId]) }
    finally { c.release() }
  })

  it('accepts claude-code-cli with no api_key on tier 0', async () => {
    process.env.PLANNEN_TIER = '0'
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.provider).toBe('claude-code-cli')
    expect(body.data.has_api_key).toBe(false)
  })

  it('rejects claude-code-cli when an api_key is supplied', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli', api_key: 'sk-bogus' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects claude-code-cli on tier 1', async () => {
    process.env.PLANNEN_TIER = '1'
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli' }),
    })
    expect(res.status).toBe(400)
    process.env.PLANNEN_TIER = '0'  // restore
  })

  it('rejects anthropic without api_key (unchanged behaviour)', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run, verify some tests fail (validation not yet present)**

Run: `cd backend && npx vitest run src/routes/api/settings.test.ts`
Expected: FAIL — currently the route accepts any provider string with any api_key.

- [ ] **Step 3: Add validation to PATCH handler**

Replace the PATCH handler body in `settings.ts` (lines 43-68) with:

```ts
settings.patch('/', async (c) => {
  const userId = c.var.userId
  const parsed = SettingsInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid settings', JSON.stringify(parsed.error.issues))
  }
  const s = parsed.data

  // Provider-specific validation.
  if (s.provider === 'claude-code-cli') {
    if (s.api_key) {
      throw new HttpError(400, 'VALIDATION',
        'claude-code-cli provider does not accept an api_key. Omit it.')
    }
    if (process.env.PLANNEN_TIER !== '0') {
      throw new HttpError(400, 'VALIDATION',
        'claude-code-cli is only available in Tier 0.')
    }
  } else if (s.provider === 'anthropic') {
    if (!s.api_key) {
      throw new HttpError(400, 'VALIDATION',
        'anthropic provider requires an api_key.')
    }
  }

  return await withUserContext(userId, async (db) => {
    if (s.is_default !== false) {
      await db.query('UPDATE plannen.user_settings SET is_default = false WHERE user_id = $1', [userId])
    }
    const { rows } = await db.query(
      `INSERT INTO plannen.user_settings (user_id, provider, api_key, base_url, default_model, is_default)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
       ON CONFLICT (user_id, provider) DO UPDATE
         SET api_key = COALESCE(EXCLUDED.api_key, plannen.user_settings.api_key),
             base_url = EXCLUDED.base_url,
             default_model = EXCLUDED.default_model,
             is_default = EXCLUDED.is_default,
             updated_at = now()
       RETURNING *`,
      [userId, s.provider, s.api_key ?? null, s.base_url ?? null, s.default_model ?? null, s.is_default ?? null],
    )
    return c.json({ data: redact(rows[0]) })
  })
})
```

**Note:** changed the `is_default` clearing condition from `if (s.is_default)` to `if (s.is_default !== false)` so that omitting the flag (the common case) still defaults the new row to true and clears prior defaults. Verify this matches existing test expectations.

- [ ] **Step 4: Run, verify all settings tests pass**

Run: `cd backend && npx vitest run src/routes/api/settings.test.ts`
Expected: PASS — all old + new tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api/settings.ts backend/src/routes/api/settings.test.ts
git commit -m "settings: validate provider+api_key per tier (anthropic / claude-code-cli)"
```

---

## Phase 5 — Web UI

### Task 14: Update `/settings` web UI for CLI provider option

This is a React app (Vite); the settings page lives at `src/components/Settings.tsx` (318 lines) and the context at `src/context/SettingsContext.tsx` (213 lines). The DB client used in Tier 0 is `src/lib/dbClient.ts`. Three sub-changes: widen the `Provider` type in the context, add a `system()` helper to `dbClient`, and wire the UI in `Settings.tsx`.

**Files:**
- Modify: `src/context/SettingsContext.tsx` — widen `Provider`; track `cliAvailable` + `tier`; pass through context
- Modify: `src/lib/dbClient.ts` — add `settings.system()` method calling `GET /api/settings/system`
- Modify: `src/components/Settings.tsx` — dropdown, conditional fields, banner

- [ ] **Step 1: Widen `Provider` union in `SettingsContext.tsx`**

Edit `src/context/SettingsContext.tsx:8`:

```ts
export type Provider = 'anthropic' | 'claude-code-cli'
```

- [ ] **Step 2: Add `system` info to `SettingsContextValue`**

In `src/context/SettingsContext.tsx`, after the `ProviderSettings` interface (line 18), add:

```ts
export interface SystemInfo {
  tier: number
  cliAvailable: boolean
  cliVersion: string | null
}
```

Extend `SettingsContextValue` (line 20-28) with `system: SystemInfo | null`. Initialise to `null` in the default context value.

In `SettingsProvider` (line 58+), add a `system` state and load it on mount in Tier 0 only:

```ts
const [system, setSystem] = useState<SystemInfo | null>(null)

useEffect(() => {
  if (TIER === '0') {
    dbClient.settings.system().then(setSystem).catch(() => setSystem(null))
  } else {
    setSystem({ tier: 1, cliAvailable: false, cliVersion: null })
  }
}, [])
```

Pass `system` in the context provider value.

- [ ] **Step 3: Add `settings.system()` to `dbClient`**

Open `src/lib/dbClient.ts`, find the existing `settings` namespace (which already has `get()` and `update()`), and add:

```ts
async system(): Promise<{ tier: number; cliAvailable: boolean; cliVersion: string | null }> {
  const res = await fetch('/api/settings/system')
  if (!res.ok) throw new Error(`settings.system failed: ${res.status}`)
  const body = await res.json()
  return body.data
},
```

- [ ] **Step 4: Wire dropdown in `Settings.tsx`**

In `src/components/Settings.tsx:28`, destructure `system` from `useSettings()`:

```ts
const { settings, loading, hasAiKey, saveProvider, clearProvider, testProvider, system } = useSettings()
const [provider, setProvider] = useState<'anthropic' | 'claude-code-cli'>(settings?.provider ?? 'anthropic')
```

Sync `provider` state from `settings` in the existing `useEffect` (line 38-46).

Find the form section that renders the API key input and model dropdown. Wrap it with a provider conditional and add the dropdown above:

```tsx
<label>Provider</label>
<select value={provider} onChange={(e) => setProvider(e.target.value as 'anthropic' | 'claude-code-cli')}>
  <option value="anthropic">Anthropic (BYOK)</option>
  {system?.tier === 0 && system.cliAvailable && (
    <option value="claude-code-cli">
      Claude Code CLI (your subscription){system.cliVersion ? ` — v${system.cliVersion}` : ''}
    </option>
  )}
</select>

{provider === 'anthropic' && (
  <>
    {/* existing API key input + model dropdown JSX stays here */}
  </>
)}

{provider === 'claude-code-cli' && (
  <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm">
    Plannen will use your installed Claude CLI for AI calls. Anthropic bills your subscription —
    no API key needed here.
  </div>
)}

{system?.tier === 0 && !system.cliAvailable && (
  <p className="text-sm text-gray-500 mt-2">
    To use your Claude subscription instead of an API key, install Claude Code at{' '}
    <a href="https://claude.com/code" className="underline">claude.com/code</a>.
  </p>
)}
```

- [ ] **Step 5: Update save handler to send the right body**

Find the existing save handler. Change the body it sends:

```ts
if (provider === 'claude-code-cli') {
  await saveProvider({ provider: 'claude-code-cli', apiKey: '', defaultModel: null })
} else {
  await saveProvider({ provider: 'anthropic', apiKey: key, defaultModel: model })
}
```

Then update `saveProvider` in `SettingsContext.tsx:124` so that when `provider === 'claude-code-cli'`, it sends `{ provider: 'claude-code-cli' }` (no api_key, no model). The backend now validates this.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors after the Provider widening.

- [ ] **Step 7: Manual verification**

Run the three-process Tier-0 stack:
1. `bash scripts/pg-start.sh`
2. `bash scripts/backend-start.sh`
3. `npm run dev`

Visit http://localhost:4321/settings. Verify:
- With `claude` in PATH: dropdown shows CLI option ("Claude Code CLI (your subscription) — v1.x.x"), selecting it hides the API key field and shows the blue banner.
- Click Save → backend returns 200; `GET /api/settings` shows provider=`claude-code-cli`, `has_api_key=false`.
- Click "Test AI" → succeeds via subprocess (takes 1-3 seconds for CLI startup + model call).
- Without `claude` in PATH (rename binary temporarily, restart backend): dropdown shows BYOK only; install hint appears.
- Tier 1 (`PLANNEN_TIER=1`): dropdown shows BYOK only; CLI option hidden entirely.

- [ ] **Step 8: Commit**

```bash
git add src/context/SettingsContext.tsx src/lib/dbClient.ts src/components/Settings.tsx
git commit -m "settings UI: surface claude-code-cli provider with conditional fields"
```

---

## Phase 6 — Smoke test script (manual verification helper)

### Task 15: Add `scripts/smoke-cli-provider.sh`

**Files:**
- Create: `scripts/smoke-cli-provider.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Manual smoke test for the claude-code-cli AI provider.
# Verifies the CLI binary works end-to-end with a one-shot generate call.
# Run after implementing the provider; not part of CI.

set -euo pipefail

echo "== claude --version =="
claude --version

echo "== one-shot generate (claude -p --output-format=json) =="
out=$(claude -p --output-format=json 'Reply with just the word "ok".')
echo "$out"

echo "== checking wrapper shape =="
if echo "$out" | jq -e '.result' > /dev/null; then
  echo "OK — wrapper has .result"
else
  echo "FAIL — wrapper missing .result"
  exit 1
fi

result=$(echo "$out" | jq -r '.result')
echo "model said: $result"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/smoke-cli-provider.sh
```

- [ ] **Step 3: Run it (will only work if `claude` is installed)**

```bash
bash scripts/smoke-cli-provider.sh
```

Expected (when `claude` is installed): prints version, wrapper JSON, and confirms `.result` contains a string like "ok".

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-cli-provider.sh
git commit -m "scripts: smoke-test for claude-code-cli AI provider"
```

---

## Phase 7 — Documentation

### Task 16: Update README + CONTRIBUTING

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add CLI-provider section to README**

Find the section describing AI/BYOK setup. Add (or update) a paragraph:

```markdown
### AI provider

Plannen needs an AI provider for Discovery, source analysis, story-writing,
and image extraction. Two options:

**Option A — Claude Code CLI (Tier 0 only).** If you already have a Claude
subscription and `claude` installed (https://claude.com/code), Plannen's
backend will auto-detect it on first boot and route AI calls through your
subscription. No API key required. Tested with Claude Code 1.x.

**Option B — BYOK Anthropic API key.** Paste a console API key into `/settings`.
Works on both Tier 0 and Tier 1.

Switch between them in `/settings` at any time.
```

- [ ] **Step 2: Add smoke-test mention to CONTRIBUTING**

```markdown
### Smoke testing the CLI provider

`scripts/smoke-cli-provider.sh` verifies the `claude` binary is reachable and
produces the expected JSON wrapper. Run it locally after touching anything in
`backend/src/_shared/providers/claude-cli.ts` or `run-cli.ts`. Not part of CI.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: document Tier-0 claude-code-cli AI provider + smoke test"
```

---

## Done — verification checklist

After Task 16:

- [ ] `cd backend && npm test` — all tests pass.
- [ ] `cd supabase/functions && deno test --allow-all` (or equivalent) — all tests pass.
- [ ] Manual smoke (`bash scripts/smoke-cli-provider.sh`) — `claude` invocation works.
- [ ] Manual Tier-0 first-boot: with no `user_settings` row, run `npm run backend` and verify the auto-config log line appears and a row is inserted.
- [ ] Manual Tier-0 second-boot: re-run backend; auto-config does NOT fire (idempotent).
- [ ] Manual Tier-0 with existing BYOK: pre-insert an anthropic row, then run backend; auto-config does NOT overwrite.
- [ ] Visit `/settings`: dropdown behaves per Task 14 verification list.
- [ ] Trigger one real AI feature (Discovery or source analysis) with CLI provider as default; verify it succeeds.

Memory update reminder: after merging, update `[[project_tier0_claude_cli_provider]]` in `~/.claude/projects/-Users-stroomnova-Music-plannen/memory/` to record that the design is implemented and where the code lives.
