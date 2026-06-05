// Shared shape for the AI module mock. Each handler test file calls
// `vi.mock('../ai.ts', () => aiMock())` (or supplies overrides) to keep
// the heavy `npm:ai@4` / `npm:@ai-sdk/anthropic@1` imports out of the
// Node test process. The mock mirrors the real public surface — same
// class hierarchy, same export names — and reads from `ctx.db.query`
// for the `no_provider_configured` path so tests can drive it with
// canned rows.

export type MockOverrides = {
  generate?: (ctx: any, opts: any) => Promise<string>
  generateStructured?: <T>(ctx: any, opts: any) => Promise<T>
  generateFromImage?: (ctx: any, opts: any) => Promise<string>
}

export function aiMock(overrides: MockOverrides = {}) {
  class AIError extends Error {
    code: string
    retryAfterSeconds: number | null
    status: number
    constructor(code: string, message: string, opts: { status?: number; retryAfterSeconds?: number | null } = {}) {
      super(message)
      this.name = 'AIError'
      this.code = code
      this.retryAfterSeconds = opts.retryAfterSeconds ?? null
      this.status = opts.status ?? (code === 'no_provider_configured' ? 400 : 500)
    }
  }
  class AIProviderNotConfigured extends AIError {
    constructor() {
      super('no_provider_configured', 'No AI provider configured for this user.', { status: 400 })
    }
  }
  const aiErrorResponse = (err: any, cors: Record<string, string>) => {
    const e = err instanceof AIError ? err : new AIError('unknown_error', String(err?.message ?? err))
    const body: Record<string, unknown> = { success: false, error: e.code, message: e.message }
    if (e.retryAfterSeconds != null) body.retry_after = e.retryAfterSeconds
    return new Response(JSON.stringify(body), {
      status: e.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const getUserAI = async (ctx: any) => {
    const { rows } = await ctx.db.query('select')
    if (rows.length === 0 || !rows[0].api_key) throw new AIProviderNotConfigured()
    return rows[0]
  }
  const ensureSettings = async (ctx: any) => {
    await getUserAI(ctx)
  }
  return {
    AIError,
    AIProviderNotConfigured,
    aiErrorResponse,
    getUserAI,
    // Each public AI call always gates on user_settings first so tests
    // can drive `no_provider_configured` with an empty rows array. The
    // override (if any) only runs once settings exist.
    generate: async (ctx: any, opts: any) => {
      await ensureSettings(ctx)
      return overrides.generate ? overrides.generate(ctx, opts) : 'ok'
    },
    generateStructured: (async (ctx: any, opts: any) => {
      await ensureSettings(ctx)
      return overrides.generateStructured ? overrides.generateStructured(ctx, opts) : ({} as any)
    }),
    generateFromImage: async (ctx: any, opts: any) => {
      await ensureSettings(ctx)
      return overrides.generateFromImage ? overrides.generateFromImage(ctx, opts) : 'mock-image-response'
    },
    withRetryAndTracking: async (_ctx: any, _s: any, fn: () => any) => fn(),
  }
}
