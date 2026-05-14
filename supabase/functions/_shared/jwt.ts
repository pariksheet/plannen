// JWT verification for Tier 1 edge functions using jose against Supabase's
// JWKS. Returns the user id ('sub' claim) for valid tokens; throws on missing
// or invalid headers. The JWKS endpoint is cached by jose's createRemoteJWKSet.

import { jwtVerify, createRemoteJWKSet } from 'npm:jose@5'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
)

export async function verifyJwt(authHeader: string | null): Promise<string> {
  if (!authHeader) throw new Error('Missing Authorization header')
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) throw new Error('Bad Authorization header shape')
  const token = m[1]
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
  })
  if (typeof payload.sub !== 'string') throw new Error('Token missing sub claim')
  return payload.sub
}
