// Central error middleware. Handlers throw HttpError for known failures;
// anything else becomes a 500 with the underlying message. Response shape
// is `{ error: { code, message, hint? } }` for both cases.

import type { Context, Next } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message)
  }
}

export async function errorMiddleware(c: Context, next: Next) {
  try {
    await next()
  } catch (e) {
    if (e instanceof HttpError) {
      // Hono narrows c.json's status to ContentfulStatusCode (>=200). HttpError
      // is constructed by handlers with concrete 4xx/5xx codes, so the cast is
      // safe — we're just satisfying the type system, not bypassing checks.
      return c.json(
        { error: { code: e.code, message: e.message, hint: e.hint } },
        e.status as ContentfulStatusCode,
      )
    }
    console.error('unhandled error', e)
    const message = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: { code: 'INTERNAL', message } }, 500)
  }
}
