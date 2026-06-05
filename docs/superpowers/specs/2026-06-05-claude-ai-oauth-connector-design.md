# claude.ai OAuth connector for the Plannen MCP — design

**Date:** 2026-06-05
**Status:** Approved

## Problem

The Plannen MCP edge function (`supabase/functions/mcp/`) is gated by a static
`Authorization: Bearer plnnn_…` token. claude.ai custom connectors only support
OAuth (or no auth) — there is no way to configure a static bearer header in the
connector UI. As a result the MCP cannot be registered on claude.ai, which is
the single registration point that propagates to claude.ai web, Claude Desktop,
mobile, and Claude in Chrome.

## Goal

Any Tier 2 Plannen install can register
`https://<ref>.supabase.co/functions/v1/mcp` as a claude.ai custom connector.
The user logs in with their Plannen account (existing OTP/passkey flows),
approves access once, and all MCP tools work across claude.ai surfaces — while
the plugin's static-token path keeps working untouched.

## Decisions made during brainstorming

- **Keep both auth paths.** The Claude Code plugin (`plugin.json`) pins a
  static `plnnn_` bearer and runs headlessly (mailbox sync, routines);
  interactive OAuth does not fit there. OAuth is additive.
- **Productized**, not prod-only: CLI verb + `cloud provision` step + docs, so
  any Tier 2 install gets this without manual dashboard work.
- **Approach A**: dual-branch auth inside the existing `mcp` function (no
  second proxy function, no waiting for Supabase platform-level MCP auth).
- Full per-user access only — no scoped-down/read-only connectors (YAGNI).
- Tier 0 stdio server (`mcp/src/index.ts`) untouched: no new tools, so the
  two-implementations sync rule is not triggered.

## Architecture

### One-time OAuth flow (when a user adds the connector)

1. claude.ai POSTs to the MCP URL with no token → `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/functions/v1/mcp/.well-known/oauth-protected-resource"`.
2. claude.ai fetches that metadata → it names Supabase Auth
   (`https://<ref>.supabase.co/auth/v1`) as the authorization server.
3. claude.ai performs dynamic client registration against Supabase Auth, then
   the PKCE authorization-code flow.
4. Supabase Auth redirects to the Plannen web app's `/oauth/consent` page;
   the user logs in (existing OTP/passkey) and approves.
5. claude.ai exchanges the code for an access JWT + refresh token; Anthropic
   auto-refreshes thereafter.

Metadata is served under the function path (edge functions cannot serve the
domain root); header-based discovery per RFC 9728 is the MCP-spec-compliant
route and is what claude.ai follows.

### Per-request auth

`authenticate()` in `supabase/functions/mcp/index.ts` branches on the bearer:

- `plnnn_…` → existing `resolveTokenToUserId()` path, byte-for-byte unchanged.
- anything else → verify as a Supabase Auth JWT (signature via the project's
  JWKS, cached in-function; validate `exp`/`iss`) → `sub` is the user id.

Both branches converge on the existing
`set_config('app.current_user_id', …)` / `request.jwt.claim.sub` mechanism in
`server.ts` — zero changes to tool handlers or RLS. The OAuth access token is
a normal Supabase session JWT, so the OAuth user is indistinguishable from a
web-app session downstream.

### Tier behavior

The dual-branch code ships in the one shared function (deployed to Tier 1 and
Tier 2 alike). Only Tier 2 enables the OAuth server — claude.ai cannot reach
localhost. On Tier 0/1 where JWKS may be absent, JWT verification simply fails
→ 401; the branch is inert with no special-casing.

## Components

### Edge function (`supabase/functions/mcp/`)

1. **`index.ts` — `authenticate()`**
   - No/malformed header → `401` + `WWW-Authenticate: Bearer
     resource_metadata="…"` (today it is a bare 401; the header is what
     triggers claude.ai's OAuth discovery).
   - `plnnn_…` → return `{ bearer }` exactly as today.
   - Else → `verifySupabaseJwt(bearer)` → `{ userId }` or 401 (also with the
     `WWW-Authenticate` header so expired tokens trigger refresh).
2. **New `_shared/jwt.ts`** — JWKS fetch from
   `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, module-level
   cache with TTL (edge instances are reused), verify with `jose`
   (Deno-native), validate `exp`/`iss`, return `sub`.
3. **New route in `index.ts`** —
   `GET <fn-path>/.well-known/oauth-protected-resource` returns the RFC 9728
   document: `resource` = the function URL, `authorization_servers` =
   `["https://<ref>.supabase.co/auth/v1"]`. Unauthenticated by design (the
   function already runs with `verify_jwt` off).
4. **`server.ts` — `buildServer()`** gains an already-resolved-user variant:
   when auth produced a `userId` directly (JWT branch), skip
   `resolveTokenToUserId` and use it. Per-request session isolation behavior
   stays as-is.

### Web app — one new route: `/oauth/consent`

Supabase's OAuth server delegates the consent screen to the app (configured as
the consent URL in Auth settings). The page:

- requires a logged-in session — if absent, bounces through the existing
  OTP/passkey login and returns;
- reads the authorization request (client name — "Claude" — and redirect
  target) via supabase-js's OAuth-server consent API;
- renders Approve / Deny; approve hands control back to Supabase Auth, which
  redirects to claude.ai's callback;
- stores nothing locally — Supabase tracks granted clients.

Exact supabase-js API names for get-authorization-details / approve / deny are
pinned at planning time against current docs.

### CLI (`cli/commands/`)

- **New verb:** `npx plannen cloud oauth enable --profile <name>` (plus
  `status`). Uses the Supabase Management API (same `SUPABASE_ACCESS_TOKEN`
  auth as other cloud verbs) to:
  1. enable the OAuth 2.1 server + dynamic client registration on the
     project's Auth config;
  2. set the consent URL to `${PLANNEN_WEB_URL}/oauth/consent`;
  3. redeploy the `mcp` edge function if needed;
  4. print the connector URL to paste into claude.ai.
- **`cloud provision`** gains an idempotent step (after Auth wiring) calling
  the same code. Resumable via the existing progress file, consistent with the
  other steps.
- **Docs:** README "Connect to claude.ai" subsection + a note in
  `docs/INTEGRATIONS.md`.

## Error handling

| Case | Behavior |
|---|---|
| Missing/garbled `Authorization` | 401 + `WWW-Authenticate` (starts OAuth discovery) |
| Expired/invalid JWT | 401 + `WWW-Authenticate` (claude.ai auto-refreshes) |
| Valid JWT but user deleted | tool-level `invalid_token` error, same as the existing dead-`plnnn_` path |
| `plnnn_` paths | completely unchanged |
| JWKS unreachable (Tier 0/1) | JWT branch 401s; static-token branch unaffected |
| OAuth server not enabled on project | connector add fails at discovery with Supabase's error; `plannen cloud oauth status` is the diagnostic |

## Testing

- **`index.test.ts`:** 401 carries `WWW-Authenticate`; metadata route returns
  well-formed RFC 9728 JSON; JWT branch accepts a token signed with a test key
  (mock JWKS) and rejects expired/bad-issuer; `plnnn_` regression cases stay
  green.
- **Consent page:** component test for logged-out bounce + approve/deny
  wiring.
- **CLI:** unit test of the Management API payload construction (mocked
  fetch), per existing CLI test patterns.
- **End-to-end (manual, on `sb_prod`):** add connector on claude.ai → login →
  consent → call `list_events` from claude.ai web and Claude in Chrome.

## Out of scope

- Scoped-down permissions (read-only connectors).
- Migrating the plugin off `plnnn_`.
- Tier 0/1 OAuth enablement.

## Risks — verify at planning time, before building

1. **claude.ai follows `WWW-Authenticate` `resource_metadata`** — spec-
   compliant, but the riskiest assumption. The plan must front-load a minimal
   probe (401 header + metadata route only, deployed to prod) before building
   the rest.
2. Exact Management API field names for OAuth-server / dynamic-client-
   registration enablement.
3. Exact supabase-js OAuth-server consent API names.
