// Central error handler. Handlers throw HttpError for known failures;
// anything else becomes a 500 with the underlying message. Response shape
// is `{ error: { code, message, hint? } }` for both cases.
//
// We register this via `app.onError(...)` rather than as a middleware so it
// catches errors thrown inside mounted sub-apps too — Hono's compose machinery
// catches handler errors before they bubble back through middleware.

import type { Context } from 'hono'
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

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HttpError) {
    // Hono narrows c.json's status to ContentfulStatusCode (>=200). HttpError
    // is constructed by handlers with concrete 4xx/5xx codes, so the cast is
    // safe — we're just satisfying the type system, not bypassing checks.
    return c.json(
      { error: { code: err.code, message: err.message, hint: err.hint } },
      err.status as ContentfulStatusCode,
    )
  }
  console.error('unhandled error', err)
  return c.json({ error: { code: 'INTERNAL', message: err.message } }, 500)
}
