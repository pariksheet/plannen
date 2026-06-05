// supabase/functions/_shared/jwt.ts
//
// Verifies Supabase Auth access tokens (JWTs) for the MCP edge function's
// OAuth branch. Signature is checked against the project's JWKS
// (asymmetric signing keys); issuer and exp are validated. Returns the
// user id (sub) or null — callers translate null into a 401.
//
// The second parameter is test-injectable: production callers omit it and
// get a module-level cached remote JWKS (jose's createRemoteJWKSet caches
// and rate-limits fetches internally).

import { jwtVerify, createRemoteJWKSet } from 'npm:jose@5'

declare const Deno: { env: { get(k: string): string | undefined } } | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

type KeyResolver = Parameters<typeof jwtVerify>[1]

let remoteJwks: KeyResolver | null = null

function defaultKeyResolver(): KeyResolver {
  if (!remoteJwks) {
    const base = envGet('SUPABASE_URL')
    // Throws on empty/invalid SUPABASE_URL (Tier 0/1 without Supabase) —
    // caught by the try/catch in verifySupabaseJwt → null → 401.
    remoteJwks = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`))
  }
  return remoteJwks
}

export async function verifySupabaseJwt(
  token: string,
  getKey?: KeyResolver,
): Promise<string | null> {
  try {
    const issuer = `${envGet('SUPABASE_URL')}/auth/v1`
    const { payload } = await jwtVerify(token, getKey ?? defaultKeyResolver(), { issuer, algorithms: ['ES256', 'RS256'] })
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
  } catch {
    return null
  }
}

// Legacy function for backward compatibility with existing edge functions.
// Throws on errors; the new verifySupabaseJwt is preferred for OAuth.
export async function verifyJwt(authHeader: string | null): Promise<string> {
  if (!authHeader) throw new Error('Missing Authorization header')
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) throw new Error('Bad Authorization header shape')
  const token = m[1]
  const issuer = `${envGet('SUPABASE_URL')}/auth/v1`
  const { payload } = await jwtVerify(token, defaultKeyResolver(), { issuer, algorithms: ['ES256', 'RS256'] })
  if (typeof payload.sub !== 'string') throw new Error('Token missing sub claim')
  return payload.sub
}
