import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import { verifySupabaseJwt } from './jwt.ts'
import type { KeyLike } from 'jose'

const BASE = 'https://test-ref.supabase.co'
const ISSUER = `${BASE}/auth/v1`

let jwks: ReturnType<typeof createLocalJWKSet>
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

beforeAll(async () => {
  process.env.SUPABASE_URL = BASE
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'ES256', use: 'sig' }] })
})

function sign(opts: { sub?: string; issuer?: string; expOffsetSec?: number } = {}) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject(opts.sub ?? 'user-123')
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expOffsetSec ?? 300))
    .sign(privateKey)
}

describe('verifySupabaseJwt', () => {
  it('returns the sub for a valid token', async () => {
    const token = await sign()
    expect(await verifySupabaseJwt(token, jwks)).toBe('user-123')
  })

  it('returns null for an expired token', async () => {
    const token = await sign({ expOffsetSec: -60 })
    expect(await verifySupabaseJwt(token, jwks)).toBeNull()
  })

  it('returns null for a wrong issuer', async () => {
    const token = await sign({ issuer: 'https://evil.example.com/auth/v1' })
    expect(await verifySupabaseJwt(token, jwks)).toBeNull()
  })

  it('returns null for garbage input', async () => {
    expect(await verifySupabaseJwt('plnnn-not-a-jwt', jwks)).toBeNull()
  })

  it('returns null for a token with an empty sub', async () => {
    const token = await sign({ sub: '' })
    expect(await verifySupabaseJwt(token, jwks)).toBeNull()
  })

  it('returns null for a token signed with a disallowed algorithm', async () => {
    const secret = new TextEncoder().encode('super-secret-key-that-is-long-enough!!')
    const now = Math.floor(Date.now() / 1000)
    const hsToken = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setSubject('user-123')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret as KeyLike)
    expect(await verifySupabaseJwt(hsToken, secret as never)).toBeNull()
  })
})
