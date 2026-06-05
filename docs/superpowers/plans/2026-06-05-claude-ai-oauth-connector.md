# claude.ai OAuth Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plannen MCP edge function registrable as a claude.ai custom connector by adding OAuth (Supabase Auth JWT) verification alongside the existing `plnnn_` static-token path.

**Architecture:** Dual-branch auth inside the existing `supabase/functions/mcp/` function — `plnnn_` bearers keep the token-table lookup; anything else verifies as a Supabase Auth JWT via JWKS. The function also serves RFC 9728 protected-resource metadata and advertises it via `WWW-Authenticate`, so claude.ai discovers Supabase Auth (OAuth 2.1 server, already shipped by Supabase) as the authorization server. The web app gains one consent page; the CLI gains `cloud oauth` + a provision step.

**Tech Stack:** Deno edge functions (vitest for tests via `supabase/functions/vitest.config.ts`), `jose` for JWT/JWKS, React + react-router (web), citty CLI (`cli/commands/`), Supabase Management API (`scripts/lib/supabase-mgmt.mjs`).

**Spec:** `docs/superpowers/specs/2026-06-05-claude-ai-oauth-connector-design.md`

**Facts pinned during planning (do not re-derive):**
- Management API auth-config fields: `oauth_server_enabled`, `oauth_server_allow_dynamic_registration`, `oauth_server_authorization_path` (PATCH `/v1/projects/{ref}/config/auth`).
- supabase-js ≥ 2.105 (installed: 2.105.3) ships `supabase.auth.oauth.getAuthorizationDetails(id)` / `.approveAuthorization(id, opts?)` / `.denyAuthorization(id, opts?)`. `getAuthorizationDetails` returns either `OAuthAuthorizationDetails` (`authorization_id`, `client: {id, name, uri, logo_uri}`, `user`, `scope`, `redirect_uri`) or `OAuthRedirect` (`redirect_url`) when already consented — narrow with `'redirect_url' in data`. Approve/deny auto-redirect the browser unless `{skipBrowserRedirect: true}`.
- Supabase OAuth endpoints once enabled: authorize `https://<ref>.supabase.co/auth/v1/oauth/authorize`, token `…/auth/v1/oauth/token`, JWKS `…/auth/v1/.well-known/jwks.json`, AS metadata `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`. Issuer claim is `https://<ref>.supabase.co/auth/v1`.
- The consent URL is configured as a **path** (`oauth_server_authorization_path`), combined with the project's Site URL (already set to the Vercel deployment by provision's `wire-auth` step).
- `Login.tsx` honors `?redirect=<path>`, and `AuthContext.signIn(email, redirectTo)` threads it into `emailRedirectTo` — the consent page's login bounce needs no auth-flow changes.
- Edge runtime injects `SUPABASE_URL`. Function tests run under vitest with `npm:<pkg>@<ver>` aliased to bare node_modules specifiers (`supabase/functions/vitest.config.ts`).
- Vitest function tests: run from `supabase/functions/` so its `vitest.config.ts` is picked up.

---

### Task 1: JWT verification module (`_shared/jwt.ts`)

**Files:**
- Create: `supabase/functions/_shared/jwt.ts`
- Test: `supabase/functions/_shared/jwt.test.ts`
- Modify: `supabase/functions/package.json` (add `jose` devDependency — used by tests; the Deno runtime fetches `npm:jose@5` itself. NOTE: `supabase/functions/` has its own package.json + node_modules; do NOT add jose to the repo-root package.json)

- [ ] **Step 1: Install jose for tests**

```bash
(cd supabase/functions && npm install -D 'jose@^5')
```

- [ ] **Step 2: Write the failing test**

Create `supabase/functions/_shared/jwt.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import { verifySupabaseJwt } from './jwt.ts'

const BASE = 'https://test-ref.supabase.co'
const ISSUER = `${BASE}/auth/v1`

let jwks: ReturnType<typeof createLocalJWKSet>
let privateKey: CryptoKey

beforeAll(async () => {
  process.env.SUPABASE_URL = BASE
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey as CryptoKey
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
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `(cd supabase/functions && npx vitest run _shared/jwt.test.ts)`
Expected: FAIL — `Cannot find module './jwt.ts'`

- [ ] **Step 4: Write the implementation**

Create `supabase/functions/_shared/jwt.ts`:

```typescript
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
    const { payload } = await jwtVerify(token, getKey ?? defaultKeyResolver(), { issuer })
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `(cd supabase/functions && npx vitest run _shared/jwt.test.ts)`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/jwt.ts supabase/functions/_shared/jwt.test.ts supabase/functions/package.json supabase/functions/package-lock.json
git commit -m "feat(mcp): Supabase JWT verification module for OAuth bearer branch"
```

---

### Task 2: Protected-resource metadata route + WWW-Authenticate header

**Files:**
- Modify: `supabase/functions/mcp/index.ts` (reply401 at lines 28-33; handleRequest at lines 49-63)
- Test: `supabase/functions/mcp/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `supabase/functions/mcp/index.test.ts` (new `describe` block at the end; also import `protectedResourceMetadata` is not needed — we go through `handleRequest`):

```typescript
describe('oauth discovery', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://test-ref.supabase.co'
  })

  it('serves RFC 9728 protected-resource metadata without auth', async () => {
    const req = new Request(
      'http://x/mcp/.well-known/oauth-protected-resource',
      { method: 'GET' },
    )
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe('https://test-ref.supabase.co/functions/v1/mcp')
    expect(body.authorization_servers).toEqual(['https://test-ref.supabase.co/auth/v1'])
    expect(body.bearer_methods_supported).toEqual(['header'])
  })

  it('401 responses carry a WWW-Authenticate header pointing at the metadata', async () => {
    const req = new Request('http://x/mcp', { method: 'POST' })
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(401)
    const www = res.headers.get('WWW-Authenticate') ?? ''
    expect(www).toContain('Bearer')
    expect(www).toContain(
      'resource_metadata="https://test-ref.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource"',
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd supabase/functions && npx vitest run mcp/index.test.ts)`
Expected: the two new tests FAIL (metadata route 401s; no WWW-Authenticate header). Existing tests still pass.

- [ ] **Step 3: Implement metadata route and header**

In `supabase/functions/mcp/index.ts`, add after the `declare const Deno` block (line 26):

```typescript
function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const WELL_KNOWN_SUFFIX = '/.well-known/oauth-protected-resource'

function mcpResourceUrl(): string {
  return `${envGet('SUPABASE_URL')}/functions/v1/mcp`
}

// RFC 9728 protected-resource metadata. Unauthenticated by design — it is
// discovery data; claude.ai fetches it after seeing the WWW-Authenticate
// header on a 401, then talks OAuth to Supabase Auth directly.
function protectedResourceMetadata(): Response {
  return new Response(
    JSON.stringify({
      resource: mcpResourceUrl(),
      authorization_servers: [`${envGet('SUPABASE_URL')}/auth/v1`],
      bearer_methods_supported: ['header'],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}
```

Replace `reply401` (lines 28-33) with:

```typescript
function reply401(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      // Tells MCP clients (claude.ai) where to find the OAuth metadata.
      'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceUrl()}${WELL_KNOWN_SUFFIX}"`,
    },
  })
}
```

In `handleRequest`, add the route **before** the `authenticate` call (i.e. as the first statement of the function body):

```typescript
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname.endsWith(WELL_KNOWN_SUFFIX)) {
    return protectedResourceMetadata()
  }
```

(Suffix match, not exact match: inside the edge runtime the pathname may or may not carry the `/functions/v1` prefix depending on router version.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd supabase/functions && npx vitest run mcp/index.test.ts)`
Expected: PASS (all, including pre-existing)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/index.ts supabase/functions/mcp/index.test.ts
git commit -m "feat(mcp): serve oauth-protected-resource metadata + WWW-Authenticate on 401"
```

---

### Task 3: Dual-branch `authenticate()` + resolved-user variant in `buildServer()`

**Files:**
- Modify: `supabase/functions/mcp/index.ts` (authenticate, lines 35-42; handleRequest)
- Modify: `supabase/functions/mcp/server.ts` (buildServer signature, lines 24, 48-51)
- Test: `supabase/functions/mcp/index.test.ts`

- [ ] **Step 1: Update existing tests + add JWT-branch tests**

In `supabase/functions/mcp/index.test.ts`:

1. Add imports at the top:

```typescript
import * as jwtModule from '../_shared/jwt.ts'
```

2. `authenticate` is becoming async — update the four existing `authenticate` tests to `await`:

```typescript
describe('authenticate', () => {
  it('returns the bearer when header is well-formed and prefixed plnnn_', async () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer plnnn_abc123' },
    })
    const r = await authenticate(req)
    expect(r).not.toBeInstanceOf(Response)
    expect((r as { bearer: string }).bearer).toBe('plnnn_abc123')
  })

  it('returns 401 missing_bearer when header is absent', async () => {
    const req = new Request('http://x/')
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    const res = r as Response
    expect(res.status).toBe(401)
    expect(await res.clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 missing_bearer when header is missing Bearer prefix', async () => {
    const req = new Request('http://x/', { headers: { Authorization: 'plnnn_abc' } })
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'missing_bearer' })
  })

  it('returns 401 invalid_token when bearer is neither plnnn_ nor a valid JWT', async () => {
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue(null)
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wrongtoken' },
    })
    const r = await authenticate(req)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).clone().json()).toEqual({ error: 'invalid_token' })
    vi.restoreAllMocks()
  })

  it('returns the userId when bearer is a valid Supabase JWT', async () => {
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue('u-jwt-1')
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.x.y' },
    })
    const r = await authenticate(req)
    expect(r).not.toBeInstanceOf(Response)
    expect((r as { userId: string }).userId).toBe('u-jwt-1')
    vi.restoreAllMocks()
  })
})
```

3. Add an end-to-end JWT-path test to the `multi-user isolation` describe block (reuses its `fakeTool` pattern):

```typescript
  it('a JWT bearer reaches the handler with the verified userId and skips token lookup', async () => {
    const seenUserIds: string[] = []
    const fakeTool: any = {
      definitions: [{ name: 'echo_user', description: 'd', inputSchema: { type: 'object' } }],
      dispatch: {
        echo_user: async (_args: unknown, ctx: { userId: string }) => {
          seenUserIds.push(ctx.userId)
          return { userId: ctx.userId }
        },
      },
    }
    vi.spyOn(jwtModule, 'verifySupabaseJwt').mockResolvedValue('u-oauth')
    const resolveSpy = vi.spyOn(userTokensModule, 'resolveTokenToUserId')

    const fakeClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    }
    const poolMod = await import('./server.ts')
    vi.spyOn(poolMod.pool, 'connect').mockResolvedValue(fakeClient as any)

    const res = await handleRequest(
      new Request('http://x/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.x.y',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'echo_user', arguments: {} },
        }),
      }),
      { tools: [fakeTool] },
    )
    expect(res.status).toBe(200)
    expect(seenUserIds).toEqual(['u-oauth'])
    expect(resolveSpy).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `(cd supabase/functions && npx vitest run mcp/index.test.ts)`
Expected: FAIL — `invalid_token` vs `invalid_token_format`, missing `userId` branch.

- [ ] **Step 3: Implement the dual branch**

In `supabase/functions/mcp/index.ts`:

Add import:

```typescript
import { verifySupabaseJwt } from '../_shared/jwt.ts'
```

Replace `authenticate` (lines 35-42) with:

```typescript
export type AuthResult = { bearer: string } | { userId: string }

export async function authenticate(req: Request): Promise<AuthResult | Response> {
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return reply401('missing_bearer')
  const bearer = header.slice(prefix.length)
  // Static PAT branch (Claude Code plugin, CLI) — resolved per tool call
  // against plannen.user_tokens in server.ts.
  if (bearer.startsWith('plnnn_')) return { bearer }
  // OAuth branch (claude.ai connector) — bearer is a Supabase Auth JWT.
  const userId = await verifySupabaseJwt(bearer)
  if (!userId) return reply401('invalid_token')
  return { userId }
}
```

In `handleRequest`, await it and pass the whole result through (replace lines 53-57):

```typescript
  const auth = await authenticate(req)
  if (auth instanceof Response) return auth

  const server = buildServer(opts.tools, auth)
```

In `supabase/functions/mcp/server.ts`:

```typescript
export type RequestAuth = { bearer: string } | { userId: string }
```

Change the `buildServer` signature (line 24) and its doc comment:

```typescript
/**
 * Build a Server with the supplied tool modules wired in. Auth must be
 * supplied per request — there is no module-level user cache so two
 * concurrent users hitting the same function instance get distinct sessions.
 * Auth is either a plnnn_ PAT (resolved against plannen.user_tokens per
 * call) or an already-verified Supabase Auth user id (OAuth branch).
 */
export function buildServer(modules: ToolModule[], auth: RequestAuth) {
```

And replace the resolution inside the CallTool handler (lines 48-51):

```typescript
      const userId = 'userId' in auth
        ? auth.userId
        : await resolveTokenToUserId(client, auth.bearer)
      if (!userId) {
        return { content: [{ type: 'text', text: 'invalid_token' }], isError: true }
      }
```

Also delete the stale comment in `index.ts` line 55 (`// auth.bearer is now available for downstream resolution (Task 5 wires this).`).

- [ ] **Step 4: Run the full function test suite**

Run: `(cd supabase/functions && npx vitest run)`
Expected: PASS — all mcp, mcp-token, and `_shared` tests green (proves the `plnnn_` path is regression-free).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/index.ts supabase/functions/mcp/server.ts supabase/functions/mcp/index.test.ts
git commit -m "feat(mcp): accept Supabase Auth JWTs alongside plnnn_ PATs"
```

---

### Task 4: CHECKPOINT — deploy probe + claude.ai discovery test (manual, front-loaded risk)

The spec's riskiest assumption is that claude.ai follows `WWW-Authenticate` → metadata → Supabase DCR. Validate it **before** building the consent page and CLI. Requires the user (human) — pause and hand over for the claude.ai-side clicks.

**Files:** none (operational).

- [ ] **Step 1: Deploy the mcp function to prod**

```bash
npx plannen functions deploy --profile prod
```

(If the command signature differs, check `npx plannen functions deploy --help`. Do NOT use raw `supabase functions deploy` — the plannen verb resolves the profile env.)

- [ ] **Step 2: Verify JWKS is non-empty on prod**

```bash
REF=$(grep '^SUPABASE_PROJECT_REF=' ~/.plannen/profiles/prod/env | cut -d= -f2)
curl -s "https://$REF.supabase.co/auth/v1/.well-known/jwks.json"
```

Expected: `{"keys":[{...}]}` with at least one key. If `{"keys":[]}`, the project is still on the legacy HS256 shared secret — migrate in Dashboard → Project Settings → JWT Keys ("Migrate to asymmetric signing keys") before continuing. **Stop and surface to the user if so.**

- [ ] **Step 3: One-time OAuth-server enablement on prod (curl; the CLI verb in Task 7 makes this repeatable)**

```bash
# SUPABASE_ACCESS_TOKEN from `supabase login` keychain or env
curl -s -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"oauth_server_enabled":true,"oauth_server_allow_dynamic_registration":true,"oauth_server_authorization_path":"/oauth/consent"}'
```

Expected: 200/204. Verify: `curl -s "https://api.supabase.com/v1/projects/$REF/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | python3 -c "import json,sys; c=json.load(sys.stdin); print({k:v for k,v in c.items() if k.startswith('oauth_server')})"`

- [ ] **Step 4: Probe the function's discovery surface**

```bash
curl -si -X POST "https://$REF.supabase.co/functions/v1/mcp" | grep -i www-authenticate
curl -s "https://$REF.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource"
curl -s "https://$REF.supabase.co/.well-known/oauth-authorization-server/auth/v1" | head -c 300
```

Expected: (1) header present with `resource_metadata="…"`; (2) JSON with `resource` + `authorization_servers`; (3) Supabase AS metadata JSON (contains `authorization_endpoint`).

- [ ] **Step 5: HUMAN — add the connector on claude.ai**

Ask the user to: claude.ai → Settings → Connectors → Add custom connector → URL `https://<ref>.supabase.co/functions/v1/mcp` → Add → click Connect.

**Success criterion:** the browser reaches `https://<web-url>/oauth/consent?authorization_id=…` (a 404/blank page is FINE — the consent page is Task 5). That proves discovery + DCR + authorize all work.

**If claude.ai errors at discovery instead:** stop, capture the error text, re-check Step 4 outputs, and investigate before any further task (this is the assumption the whole plan rests on).

- [ ] **Step 6: Commit nothing** — operational task; note results in the session.

---

### Task 5: Web app consent page (`/oauth/consent`)

**Files:**
- Create: `src/pages/OAuthConsent.tsx`
- Modify: `src/routes/AppRoutes.tsx` (add lazy import + route)
- Test: `tests/components/OAuthConsent.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/OAuthConsent.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const getAuthorizationDetails = vi.fn()
const approveAuthorization = vi.fn()
const denyAuthorization = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      oauth: {
        getAuthorizationDetails: (...a: unknown[]) => getAuthorizationDetails(...a),
        approveAuthorization: (...a: unknown[]) => approveAuthorization(...a),
        denyAuthorization: (...a: unknown[]) => denyAuthorization(...a),
      },
    },
  },
}))

const mockAuth = { user: { id: 'u1', email: 'p@x.com' }, loading: false }
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => mockAuth,
}))

import { OAuthConsent } from '../../src/pages/OAuthConsent'

function renderConsent(search = '?authorization_id=auth-123') {
  return render(
    <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.user = { id: 'u1', email: 'p@x.com' }
  mockAuth.loading = false
})

describe('OAuthConsent', () => {
  it('shows client name and scopes when consent is needed', async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: 'auth-123',
        client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
        user: { id: 'u1', email: 'p@x.com' },
        scope: 'openid email',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      },
      error: null,
    })
    renderConsent()
    await waitFor(() => expect(screen.getByText(/Claude/)).toBeInTheDocument())
    expect(getAuthorizationDetails).toHaveBeenCalledWith('auth-123')
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
  })

  it('approve calls approveAuthorization with the authorization id', async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: 'auth-123',
        client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
        user: { id: 'u1', email: 'p@x.com' },
        scope: 'openid email',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      },
      error: null,
    })
    approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=x' }, error: null })
    renderConsent()
    await waitFor(() => screen.getByRole('button', { name: /approve/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(approveAuthorization).toHaveBeenCalledWith('auth-123')
  })

  it('redirects to login (preserving the consent URL) when logged out', async () => {
    mockAuth.user = null as never
    renderConsent()
    await waitFor(() => expect(screen.getByText('login-page')).toBeInTheDocument())
  })

  it('shows an error when authorization_id is missing', async () => {
    renderConsent('')
    await waitFor(() => expect(screen.getByText(/missing authorization/i)).toBeInTheDocument())
    expect(getAuthorizationDetails).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/OAuthConsent.test.tsx`
Expected: FAIL — module `src/pages/OAuthConsent` not found.

- [ ] **Step 3: Implement the page**

Create `src/pages/OAuthConsent.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

type ConsentDetails = { clientName: string; scope: string }

// OAuth 2.1 consent screen. Supabase Auth redirects here (the project's
// oauth_server_authorization_path) during the authorize flow — e.g. when a
// user connects the Plannen MCP as a claude.ai custom connector. Approve /
// deny hand control back to Supabase, which redirects to the OAuth client.
export function OAuthConsent() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const authorizationId = searchParams.get('authorization_id')
  const [details, setDetails] = useState<ConsentDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (loading) return
    if (!user) {
      // Login.tsx honors ?redirect= and signIn threads it into
      // emailRedirectTo, so both passkey and OTP logins land back here.
      const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId ?? '')}`
      navigate(`/login?redirect=${encodeURIComponent(next)}`, { replace: true })
      return
    }
    if (!authorizationId) {
      setError('Missing authorization request. Start again from the app you are connecting.')
      return
    }
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: err }) => {
      if (err || !data) {
        setError(err?.message ?? 'Could not load the authorization request.')
        return
      }
      if ('redirect_url' in data) {
        // Already consented — bounce straight back to the client.
        window.location.href = data.redirect_url
        return
      }
      setDetails({ clientName: data.client.name, scope: data.scope })
    })
  }, [user, loading, authorizationId, navigate])

  const decide = async (action: 'approve' | 'deny') => {
    if (!authorizationId) return
    setBusy(true)
    // Default options auto-redirect the browser via the returned redirect_url.
    const { error: err } = action === 'approve'
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId)
    if (err) {
      setBusy(false)
      setError(err.message)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white shadow-sm rounded-lg p-6 border border-gray-200 space-y-4">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !details ? (
          <p className="text-sm text-gray-600">Loading authorization request…</p>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-gray-900">
              Allow {details.clientName} to access your Plannen account?
            </h1>
            <p className="text-sm text-gray-600">
              {details.clientName} will be able to act as you in Plannen
              (events, watches, stories, profile). Requested scopes:{' '}
              <span className="font-mono">{details.scope}</span>
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                onClick={() => decide('approve')}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-50"
                onClick={() => decide('deny')}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

In `src/routes/AppRoutes.tsx` add the lazy import (after the `ShareTarget` line):

```tsx
const OAuthConsent = lazy(() => import('../pages/OAuthConsent').then((m) => ({ default: m.OAuthConsent })))
```

and the route (next to the other public routes — the page does its own login bounce so `ProtectedRoute`'s redirect, which drops query params, is deliberately NOT used):

```tsx
        <Route path="/oauth/consent" element={<OAuthConsent />} />
```

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run tests/components/OAuthConsent.test.tsx && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/OAuthConsent.tsx src/routes/AppRoutes.tsx tests/components/OAuthConsent.test.tsx
git commit -m "feat(web): OAuth consent page for Supabase Auth OAuth 2.1 server"
```

---

### Task 6: `updateOAuthServerConfig` in supabase-mgmt

**Files:**
- Modify: `scripts/lib/supabase-mgmt.mjs` (add export after `updatePasskeyConfig`, line 143)
- Test: `tests/scripts/supabase-mgmt.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/scripts/supabase-mgmt.test.ts` (import `updateOAuthServerConfig` in the existing import block; new describe at the end). Mirror the existing mocked-fetch style used by the `updateAuthConfig`/`updatePasskeyConfig` tests in this file:

```typescript
describe('updateOAuthServerConfig', () => {
  function fakeFetch(currentConfig: Record<string, unknown>) {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (!init || init.method === 'GET' || init.method === undefined) {
        return new Response(JSON.stringify(currentConfig), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    return { calls, fetch }
  }

  it('enables oauth server + DCR + sets the authorization path', async () => {
    const { calls, fetch } = fakeFetch({})
    const r = await updateOAuthServerConfig('tok', 'ref1', { authorizationPath: '/oauth/consent' }, { fetch })
    expect(r.changed).toBe(true)
    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(String(patch!.init!.body))).toEqual({
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: '/oauth/consent',
    })
  })

  it('is a no-op when everything already matches', async () => {
    const { calls, fetch } = fakeFetch({
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: '/oauth/consent',
    })
    const r = await updateOAuthServerConfig('tok', 'ref1', { authorizationPath: '/oauth/consent' }, { fetch })
    expect(r.changed).toBe(false)
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/supabase-mgmt.test.ts`
Expected: FAIL — `updateOAuthServerConfig` is not exported.

- [ ] **Step 3: Implement**

Add to `scripts/lib/supabase-mgmt.mjs` after `updatePasskeyConfig`:

```javascript
// IO: enable the OAuth 2.1 server on a project (claude.ai custom connector
// support). Patches oauth_server_enabled + dynamic client registration +
// the authorization (consent) path. Idempotent — no PATCH when current
// state already matches.
//
// patch = { authorizationPath: string }
export async function updateOAuthServerConfig(token, ref, patch, { fetch = globalThis.fetch } = {}) {
  const current = await getAuthConfig(token, ref, { fetch });
  const body = {};
  if (current.oauth_server_enabled !== true) {
    body.oauth_server_enabled = true;
  }
  if (current.oauth_server_allow_dynamic_registration !== true) {
    body.oauth_server_allow_dynamic_registration = true;
  }
  if (patch.authorizationPath && patch.authorizationPath !== current.oauth_server_authorization_path) {
    body.oauth_server_authorization_path = patch.authorizationPath;
  }
  if (Object.keys(body).length === 0) return { changed: false };
  await request({ method: 'PATCH', path: `/projects/${ref}/config/auth`, body, token, fetch });
  return { changed: true, body };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/supabase-mgmt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/supabase-mgmt.mjs tests/scripts/supabase-mgmt.test.ts
git commit -m "feat(cli): updateOAuthServerConfig management-api helper"
```

---

### Task 7: `plannen cloud oauth` command

**Files:**
- Create: `cli/commands/cloud/oauth.mjs`
- Modify: `cli/commands/cloud/index.mjs`
- Test: `cli/__tests__/cloud-oauth.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `cli/__tests__/cloud-oauth.test.mjs` (mirrors `cloud-passkeys.test.mjs`'s tmp-HOME + injected-mgmt pattern):

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invokeOauthEnable, invokeOauthStatus } from '../commands/cloud/oauth.mjs';
import { invokeProfileCreate } from '../commands/profile/create.mjs';
import { getProfileEnvPath } from '../lib/profiles.mjs';

let tmpHome;
const env = () => ({ HOME: tmpHome });
const now = () => '2026-06-05T00:00:00Z';

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-oauth-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function withProfile(name, mode, envFields = {}) {
  await invokeProfileCreate({ name, mode }, { env: env(), now });
  if (Object.keys(envFields).length) {
    const envPath = getProfileEnvPath(name, env());
    const lines = Object.entries(envFields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    appendFileSync(envPath, lines);
  }
}

function makeMgmt(overrides = {}) {
  const calls = { updateOAuthServerConfig: [], getAuthConfig: [] };
  return {
    calls,
    mgmt: {
      readAccessToken: () => 'fake-token',
      updateOAuthServerConfig: async (token, ref, patch) => {
        calls.updateOAuthServerConfig.push({ token, ref, patch });
        return { changed: true, body: patch };
      },
      getAuthConfig: async (token, ref) => {
        calls.getAuthConfig.push({ token, ref });
        return {
          oauth_server_enabled: true,
          oauth_server_allow_dynamic_registration: true,
          oauth_server_authorization_path: '/oauth/consent',
        };
      },
      ...overrides,
    },
  };
}

describe('invokeOauthEnable', () => {
  it('refuses non-cloud_sb profiles', async () => {
    await withProfile('local', 'local_pg');
    await expect(
      invokeOauthEnable({ profile: 'local' }, { env: env(), supabaseMgmt: makeMgmt().mgmt }),
    ).rejects.toThrow(/cloud_sb required/);
  });

  it('refuses when the profile has no SUPABASE_PROJECT_REF', async () => {
    await withProfile('prod', 'cloud_sb');
    await expect(
      invokeOauthEnable({ profile: 'prod' }, { env: env(), supabaseMgmt: makeMgmt().mgmt }),
    ).rejects.toThrow(/SUPABASE_PROJECT_REF/);
  });

  it('patches the oauth server config and prints the connector URL', async () => {
    await withProfile('prod', 'cloud_sb', {
      SUPABASE_PROJECT_REF: 'refxyz',
      PLANNEN_WEB_URL: 'https://plannen.example.app',
    });
    const { calls, mgmt } = makeMgmt();
    const lines = [];
    const result = await invokeOauthEnable(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: (s) => lines.push(s) },
    );
    expect(calls.updateOAuthServerConfig).toEqual([
      { token: 'fake-token', ref: 'refxyz', patch: { authorizationPath: '/oauth/consent' } },
    ]);
    expect(result.connectorUrl).toBe('https://refxyz.supabase.co/functions/v1/mcp');
    expect(lines.join('\n')).toContain('https://refxyz.supabase.co/functions/v1/mcp');
  });

  it('throws when no Supabase access token is available', async () => {
    await withProfile('prod', 'cloud_sb', { SUPABASE_PROJECT_REF: 'refxyz' });
    const { mgmt } = makeMgmt({ readAccessToken: () => null });
    await expect(
      invokeOauthEnable({ profile: 'prod' }, { env: env(), supabaseMgmt: mgmt }),
    ).rejects.toThrow(/access token/);
  });
});

describe('invokeOauthStatus', () => {
  it('reports the oauth_server_* fields', async () => {
    await withProfile('prod', 'cloud_sb', { SUPABASE_PROJECT_REF: 'refxyz' });
    const { calls, mgmt } = makeMgmt();
    const lines = [];
    const status = await invokeOauthStatus(
      { profile: 'prod' },
      { env: env(), supabaseMgmt: mgmt, log: (s) => lines.push(s) },
    );
    expect(calls.getAuthConfig).toEqual([{ token: 'fake-token', ref: 'refxyz' }]);
    expect(status.enabled).toBe(true);
    expect(status.authorizationPath).toBe('/oauth/consent');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest --config cli/vitest.config.mjs run cli/__tests__/cloud-oauth.test.mjs`
Expected: FAIL — module `../commands/cloud/oauth.mjs` not found.

- [ ] **Step 3: Implement the command**

Create `cli/commands/cloud/oauth.mjs`:

```javascript
import { defineCommand } from 'citty';
import {
  composeEnv,
  profileExists,
  readManifest,
} from '../../lib/profiles.mjs';
import * as supabaseMgmt from '../../../scripts/lib/supabase-mgmt.mjs';

export const CONSENT_PATH = '/oauth/consent';

function resolveCloudProfile(verb, args, baseEnv) {
  const profileName = args.profile;
  if (!profileName) {
    throw new Error(`cloud oauth ${verb}: --profile <name> is required`);
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`cloud oauth ${verb}: profile '${profileName}' does not exist`);
  }
  const manifest = readManifest(profileName, baseEnv);
  if (manifest.mode !== 'cloud_sb') {
    throw new Error(
      `cloud oauth ${verb}: profile '${profileName}' has mode=${manifest.mode}; cloud_sb required`,
    );
  }
  const env = composeEnv(profileName, {}, baseEnv);
  const projectRef = env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new Error(
      `cloud oauth ${verb}: profile '${profileName}' has no SUPABASE_PROJECT_REF; ` +
      `run \`plannen cloud provision --profile ${profileName}\` first`,
    );
  }
  return { profileName, env, projectRef };
}

/**
 * Enable the Supabase OAuth 2.1 server so the MCP edge function can be
 * registered as a claude.ai custom connector.
 *
 * args = { profile: string }
 * ctx = { env?, log?, supabaseMgmt? }
 *
 * Idempotent — mgmt.updateOAuthServerConfig is a no-op when current state
 * already matches.
 */
export async function invokeOauthEnable(args, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;

  const { profileName, env, projectRef } = resolveCloudProfile('enable', args, baseEnv);

  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    throw new Error(
      'cloud oauth enable: no Supabase access token found. Run `supabase login` ' +
      '(or set SUPABASE_ACCESS_TOKEN).',
    );
  }

  log(`==> enabling OAuth 2.1 server on '${profileName}' (ref ${projectRef})`);
  log(`  consent page: ${env.PLANNEN_WEB_URL ?? '<site url>'}${CONSENT_PATH}`);

  const result = await mgmt.updateOAuthServerConfig(token, projectRef, {
    authorizationPath: CONSENT_PATH,
  });

  const connectorUrl = `https://${projectRef}.supabase.co/functions/v1/mcp`;
  log(`==> ${result.changed ? 'updated' : 'already up to date'}`);
  log('');
  log('  Register on claude.ai → Settings → Connectors → Add custom connector:');
  log(`    ${connectorUrl}`);
  log('');
  log('  Connectors propagate to claude.ai web, Claude Desktop, mobile, and');
  log('  Claude in Chrome. Each user logs in with their Plannen account.');
  return { connectorUrl, changed: result.changed };
}

/**
 * Report the project's oauth_server_* auth-config state.
 */
export async function invokeOauthStatus(args, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;

  const { profileName, projectRef } = resolveCloudProfile('status', args, baseEnv);

  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    throw new Error(
      'cloud oauth status: no Supabase access token found. Run `supabase login` ' +
      '(or set SUPABASE_ACCESS_TOKEN).',
    );
  }

  const config = await mgmt.getAuthConfig(token, projectRef);
  const status = {
    enabled: config.oauth_server_enabled === true,
    dynamicRegistration: config.oauth_server_allow_dynamic_registration === true,
    authorizationPath: config.oauth_server_authorization_path ?? null,
  };
  log(`==> oauth server on '${profileName}' (ref ${projectRef})`);
  log(`  enabled:               ${status.enabled}`);
  log(`  dynamic registration:  ${status.dynamicRegistration}`);
  log(`  authorization path:    ${status.authorizationPath ?? '(unset)'}`);
  return status;
}

const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description: 'Enable the Supabase OAuth 2.1 server (claude.ai connector support) on a cloud_sb profile',
  },
  args: {
    profile: { type: 'string', description: 'Profile to enable the OAuth server on', required: true },
  },
  async run({ args }) {
    await invokeOauthEnable({ profile: args.profile }, {});
    process.exit(0);
  },
});

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the OAuth server config for a cloud_sb profile' },
  args: {
    profile: { type: 'string', description: 'Profile to inspect', required: true },
  },
  async run({ args }) {
    await invokeOauthStatus({ profile: args.profile }, {});
    process.exit(0);
  },
});

export const oauthCommand = defineCommand({
  meta: { name: 'oauth', description: 'OAuth 2.1 server configuration (claude.ai custom connectors)' },
  subCommands: { enable: enableCommand, status: statusCommand },
});
```

Register in `cli/commands/cloud/index.mjs`:

```javascript
import { defineCommand } from 'citty';
import { provisionCommand } from './provision.mjs';
import { passkeysCommand } from './passkeys.mjs';
import { oauthCommand } from './oauth.mjs';

export const cloudCommand = defineCommand({
  meta: { name: 'cloud', description: 'Cloud (Tier 2) provisioning + lifecycle' },
  subCommands: {
    provision: provisionCommand,
    passkeys: passkeysCommand,
    oauth: oauthCommand,
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --config cli/vitest.config.mjs run cli/__tests__/cloud-oauth.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full CLI suite (help output etc. may assert subcommand lists)**

Run: `npm run test:cli`
Expected: PASS. If `help.test.mjs` asserts the cloud subcommand list, update its expectation to include `oauth`.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/cloud/oauth.mjs cli/commands/cloud/index.mjs cli/__tests__/cloud-oauth.test.mjs
git commit -m "feat(cli): plannen cloud oauth enable/status"
```

---

### Task 8: Provision step `enable-oauth` + docs

**Files:**
- Modify: `cli/commands/cloud/provision.mjs` (STEPS array line 34-46; switch ~line 204; helper after `enablePasskeys` ~line 494)
- Modify: `cli/__tests__/cloud-provision.test.mjs`
- Modify: `README.md`, `docs/INTEGRATIONS.md`

- [ ] **Step 1: Write the failing test**

In `cli/__tests__/cloud-provision.test.mjs`, add (in the describe block that asserts STEPS — find it with `grep -n "STEPS" cli/__tests__/cloud-provision.test.mjs`):

```javascript
it('includes enable-oauth as the final step', () => {
  expect(STEPS[STEPS.length - 1]).toBe('enable-oauth');
});
```

If the existing tests drive `invokeProvision` with a mocked mgmt through all steps, extend the mock with `updateOAuthServerConfig: async () => ({ changed: true })` so the run completes, and assert it was called once.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest --config cli/vitest.config.mjs run cli/__tests__/cloud-provision.test.mjs`
Expected: FAIL — last step is `enable-passkeys`.

- [ ] **Step 3: Implement the step**

In `cli/commands/cloud/provision.mjs`:

1. Append to `STEPS`:

```javascript
  'enable-oauth',        // OAuth 2.1 server + DCR + consent path via Management API (claude.ai connectors)
```

2. Add the switch case after `enable-passkeys` (line ~206):

```javascript
      case 'enable-oauth':
        await enableOauth(cur, { mgmt, log, baseEnv });
        break;
```

3. Add the helper after `enablePasskeys` (mirroring its skip-on-missing-token shape):

```javascript
async function enableOauth(cur, { mgmt, log, baseEnv }) {
  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    log('  enable-oauth: skipping (no Supabase access token; run `plannen cloud oauth enable` later)');
    return;
  }
  // Consent path combines with the Site URL set by wire-auth, so the full
  // consent page lives at <web-url>/oauth/consent (served by the web app).
  const result = await mgmt.updateOAuthServerConfig(token, cur.projectRef, {
    authorizationPath: '/oauth/consent',
  });
  const connectorUrl = `https://${cur.projectRef}.supabase.co/functions/v1/mcp`;
  log(`  enable-oauth: ${result.changed ? '✓ enabled' : '✓ already enabled'}`);
  log(`  enable-oauth: claude.ai connector URL → ${connectorUrl}`);
}
```

- [ ] **Step 4: Run provision tests**

Run: `npx vitest --config cli/vitest.config.mjs run cli/__tests__/cloud-provision.test.mjs`
Expected: PASS

- [ ] **Step 5: Docs**

In `README.md`, add a subsection near the existing integrations/setup material (match surrounding heading levels):

```markdown
### Connect Plannen to claude.ai (web, Desktop, mobile, Chrome)

Tier 2 installs can register the Plannen MCP as a claude.ai custom connector:

1. `npx plannen cloud oauth enable --profile prod` (provision runs this automatically for new installs)
2. claude.ai → Settings → Connectors → Add custom connector → paste the printed URL
3. Click Connect — log in with your Plannen account and approve

The connector then works across claude.ai web, Claude Desktop, mobile, and
Claude in Chrome. The Claude Code plugin is unaffected — it keeps its
`plnnn_` token from `plugin.json`.
```

In `docs/INTEGRATIONS.md`, add this paragraph in the section that describes the MCP server (adjust the heading reference to match the file's structure):

```markdown
The MCP edge function accepts two credentials: `plnnn_` personal access
tokens (Claude Code plugin, CLI — pinned in `plugin.json`) and Supabase Auth
JWTs obtained via the OAuth 2.1 server (claude.ai custom connectors). Both
resolve to the same per-user RLS context, so a claude.ai session and a
Claude Code session see identical data. Enable the OAuth path on a Tier 2
project with `npx plannen cloud oauth enable --profile <name>`.
```

- [ ] **Step 6: Commit**

```bash
git add cli/commands/cloud/provision.mjs cli/__tests__/cloud-provision.test.mjs README.md docs/INTEGRATIONS.md
git commit -m "feat(cli): enable-oauth provision step + claude.ai connector docs"
```

---

### Task 9: End-to-end verification on prod (manual, with the user)

**Files:** none (operational). Requires the human for claude.ai-side clicks.

- [ ] **Step 1: Deploy everything to prod**

```bash
npx plannen functions deploy --profile prod   # mcp function with dual-branch auth
npx plannen deploy                             # web app with /oauth/consent
npx plannen cloud oauth enable --profile prod  # idempotent re-assert + prints connector URL
npx plannen cloud oauth status --profile prod  # expect enabled=true, path=/oauth/consent
```

- [ ] **Step 2: HUMAN — full connector flow on claude.ai**

Ask the user to remove the Task 4 probe connector if claude.ai kept it, then re-add: Settings → Connectors → Add custom connector → the printed URL → Connect → log in (passkey or OTP) → consent page shows "Allow Claude…" → Approve → claude.ai shows the connector as connected.

- [ ] **Step 3: HUMAN — tool smoke test from claude.ai web and Claude in Chrome**

Ask the user to prompt Claude (web, then Chrome) with: *"Using the plannen connector, list my events for this month (limit 50)."*
Expected: `list_events` executes and returns the user's events (per `feedback_list_events_limit`, the prompt forces a high limit).

- [ ] **Step 4: Regression — Claude Code plugin still works**

In a Claude Code session in this repo, call any plannen MCP tool (e.g. `list_locations`).
Expected: works unchanged (static `plnnn_` path).

- [ ] **Step 5: Record results**

If anything failed, debug before closing out. On success, note in the session summary which surfaces were verified (claude.ai web / Desktop / Chrome).
