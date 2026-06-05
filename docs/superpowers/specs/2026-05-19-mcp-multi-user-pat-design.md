# MCP multi-user via Personal Access Tokens (PATs)

**Date:** 2026-05-19
**Type:** Auth + schema + edge function + CLI
**Status:** Design approved
**Tiers:** 1, 2 (tier 0 unaffected)
**Breaking change:** yes — old `MCP_BEARER_TOKEN` values stop working after deploy. Bump 0.5.x → 0.6.0.

## Problem

In tier 1 and tier 2 today, the HTTP MCP server (`supabase/functions/mcp/`) authenticates with a single shared `MCP_BEARER_TOKEN` env var. Identity is hardcoded via `PLANNEN_USER_EMAIL`, also one per deployment. The function still sets `app.current_user_id` / `request.jwt.claim.sub` GUCs and RLS does run — but always as one user. There is also a module-level `_userId` cache in `supabase/functions/mcp/server.ts:22-29` that would, in a multi-user world, leak the first caller's identity to every subsequent request — a latent bug we have to remove anyway.

The data model is already multi-user (households, circles, RLS policies are user-scoped). Only the MCP auth layer is single-user. To let a household share one tier-2 deployment — admin, spouse, kids, friends — each member needs their own credential, mintable per-device, revocable individually, like a GitHub or Notion PAT.

## Goals

- Each MCP call is attributable to one specific user; `auth.uid()` resolves to that user; RLS scopes naturally.
- Each user can hold multiple named tokens (laptop, work, VPS).
- Tokens are revocable instantly.
- No web-UI dependency for the deployment admin: the CLI can mint, list, revoke directly via the profile's `DATABASE_URL`.
- Invited users (no DB access) can self-serve mint via the web UI after magic-link sign-in.
- Tier 0 is untouched (single-user by design; still resolves identity via `PLANNEN_USER_EMAIL`).
- Other edge functions are untouched (they already authenticate per-user via Supabase JWT in `_shared/jwt.ts`).

## Non-goals

- Per-tool scopes (read-only vs write, per-tool permission grants). YAGNI; revisit if a use case appears.
- Rate-limiting the mint endpoint. Out of scope; file as follow-up.
- Bringing PAT auth to the non-MCP edge functions. They already work; add later if a script/agent needs direct access.
- Federated identity (OIDC, SAML, etc.). Magic link via Supabase Auth stays as the sole sign-in path for the web UI.
- Backwards compatibility with the old shared bearer. Clean break.

## Architecture overview

```
┌─────────────────────┐    Bearer <PAT>     ┌──────────────────────────┐
│ Claude Code plugin  │ ──────────────────► │ supabase/functions/mcp/  │
│ plugin.json         │                     │ index.ts → authenticate()│
│ Authorization:      │                     │ + server.ts → resolve()  │
│   Bearer plnnn_xxx  │                     └─────────────┬────────────┘
└─────────────────────┘                                   │
        ▲                                                 │ sha256(PAT)
        │ pasted/written by                               ▼
        │                                       ┌──────────────────────┐
┌───────┴─────────┐                             │ plannen.user_tokens  │
│ Mint surfaces:  │      INSERT (hashed)        │  - id, user_id       │
│  • CLI:         │ ──────────────────────────► │  - label, prefix     │
│   plannen token │                             │  - token_hash        │
│  • Web UI:      │                             │  - created_at        │
│   /settings →   │                             │  - last_used_at      │
│   mcp-token     │                             │  - expires_at (NULL  │
│   edge function │                             │    by default)       │
└─────────────────┘                             └──────────────────────┘
```

**Two auth surfaces coexist:**

- **Supabase JWT** (existing) — used by the web app and every existing edge function except `mcp`. Includes the new `mcp-token` mint function. Unchanged.
- **Opaque PAT** (new) — used only on the `mcp` function. Validated by hash lookup in `plannen.user_tokens`.

They never compete on the same endpoint.

## Schema

One additive migration: `supabase/migrations/YYYYMMDDHHMMSS_user_tokens.sql`.

```sql
create table plannen.user_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references plannen.users(id) on delete cascade,
  label         text not null check (length(trim(label)) > 0),
  token_hash    bytea not null,
  prefix        text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz
);

create unique index user_tokens_token_hash_idx on plannen.user_tokens (token_hash);
create index user_tokens_user_id_idx on plannen.user_tokens (user_id);

alter table plannen.user_tokens enable row level security;

create policy user_tokens_select_self on plannen.user_tokens
  for select using (user_id = auth.uid());
create policy user_tokens_insert_self on plannen.user_tokens
  for insert with check (user_id = auth.uid());
create policy user_tokens_delete_self on plannen.user_tokens
  for delete using (user_id = auth.uid());
-- No UPDATE policy: tokens are immutable once minted (label/expiry change = revoke + re-mint).
```

**Why these choices:**

- **`token_hash bytea` (sha-256, not bcrypt).** PATs already carry 256 bits of entropy; bcrypt brings nothing and breaks indexed lookup.
- **`prefix` stored separately.** Lets the UI show "MacBook — `plnnn_a1b2c3…`" without exposing plaintext.
- **`expires_at` nullable, default null.** Household tool — tokens that silently die at 2 a.m. are user-hostile. Users may set one if they want.
- **`label` required, non-empty.** Enforced by check constraint at the schema level — defense against both the CLI and the API.
- **No UPDATE policy.** Mutating fields creates audit gaps. Re-mint instead.
- **Cascade delete on user.** Orphan-token cleanup is automatic; no scheduled job needed.

## Token format on the wire

```
plnnn_<43 chars of base64url, no padding>
```

- `plnnn_` prefix is greppable like GitHub's `ghp_` and makes accidental commits self-flagging.
- 43 base64url chars = 32 random bytes = 256 bits of entropy.
- Total length: 49 chars.
- Shown to the user **exactly once** at mint time. Never retrievable after.

## Shared helper boundary

Two parallel files — matching the existing `userResolver.ts` duplication pattern (`mcp/src/userResolver.ts` ↔ `supabase/functions/_shared/userResolver.ts`):

```
supabase/functions/_shared/userTokens.ts   (Deno, for edge functions)
scripts/lib/userTokens.mjs                  (Node, for CLI)

both expose:
  ├─ mintToken(client, userId, label, expiresAt?)  → { id, plaintext, prefix }
  ├─ listTokens(client, userId)                    → row[]
  ├─ revokeToken(client, userId, id)               → boolean
  └─ resolveTokenToUserId(client, plaintext)       → userId | null
```

Consumers:
- `supabase/functions/mcp-token/index.ts` — imports from `_shared/userTokens.ts`.
- `supabase/functions/mcp/server.ts` — imports `resolveTokenToUserId` from `_shared/userTokens.ts`.
- `cli/commands/token/*.mjs` — imports from `scripts/lib/userTokens.mjs`.
- `cli/commands/cloud/provision.mjs` — imports `mintToken` from `scripts/lib/userTokens.mjs` for the auto-mint step.

Both files use only `pg` + `node:crypto` so the logic is identical; the duplication is acceptably small (~80 lines each) and matches how the codebase already handles cross-runtime sharing.

## Issuance paths

### CLI (admin / dev shortcut)

```
plannen token create [--label <name>] [--expires <ISO date>] [--no-activate]
plannen token list
plannen token revoke <id>
plannen token activate <PAT>
plannen token rotate
```

| Verb | Needs DB? | Who uses it |
|---|---|---|
| `token create` | yes (active profile's `DATABASE_URL`) | admin / dev |
| `token list` | yes | admin / dev |
| `token revoke` | yes | admin / dev |
| `token activate` | **no** — wire-only | anyone who got a PAT from /settings |
| `token rotate` | yes | admin / dev — revoke current `MCP_BEARER_TOKEN`, mint fresh, re-wire profile env + plugin.json. Replaces `scripts/mcp-rotate-bearer.sh`. |

**`plannen token create` default behavior:**

1. Resolves `user_id` from active profile's `PLANNEN_USER_EMAIL` using the existing `resolveUserIdByEmail` pattern.
2. Calls `mintToken(client, userId, label)`.
3. Writes `MCP_BEARER_TOKEN=<plaintext>` to the active profile env file.
4. Re-runs the `mcp-mode.sh http` plugin.json rewrite with the new value.
5. Prints the plaintext + label + "save it now, you won't see it again" warning.

`--no-activate` skips steps 3–4 (admin minting for someone else).

**`plannen token activate <PAT>`** — no DB call. Validates the supplied string starts with `plnnn_` and is the expected length; writes profile env; rewrites plugin.json. This is the invited-user setup path.

### Web UI (`/settings` → "Personal access tokens")

A new section on the existing `/settings` page (where the BYOK Anthropic key already lives). Three pieces:

- **Generate** button → modal with required `label` field and optional `expires_at` ("Never" by default). Submit → POST.
- **Token list** table: label, prefix (`plnnn_a1b2c3…`), "Last used: N days ago", "Expires: never" / date, Revoke button.
- **One-time-display panel** after mint: plaintext PAT, "Copy" button, "I've saved this token" confirmation before dismissing. No re-show.

### Edge function `supabase/functions/mcp-token/`

Authenticates with `_shared/jwt.ts:verifyJwt()` — i.e., the user's existing browser session JWT. Three verbs:

| Method | Behavior |
|--------|----------|
| `POST` | Body `{ label, expires_at? }`. Calls `mintToken`. Returns `{ id, plaintext, prefix, label, created_at, expires_at }`. Plaintext returned once. |
| `GET` | Calls `listTokens`. Returns user's rows (label, prefix, created_at, last_used_at, expires_at, id) — no plaintext, no hash. |
| `DELETE /:id` | Calls `revokeToken`. Returns 204 on success, 404 if id not owned by caller (indistinguishable from "doesn't exist"). |

~80 lines: `verifyJwt` for user_id, switch on method, delegate to helper.

### Auto-mint during `plannen cloud provision`

Replaces today's shared-bearer generation in `scripts/lib/mcp-rotate-bearer.mjs`. New step:

1. Ensure the admin's `plannen.users` row exists (already part of provision).
2. Call `mintToken(client, adminUserId, "provision-<hostname>")`.
3. Write plaintext to profile env as `MCP_BEARER_TOKEN`.
4. Wire plugin.json with the new value.

`scripts/mcp-rotate-bearer.sh` is replaced by `plannen token rotate` (revoke current token, mint fresh, re-wire). Old script deleted.

## MCP function validation (hot path)

### Removed

- `supabase/functions/mcp/index.ts:35` — `MCP_BEARER_TOKEN` env read.
- `supabase/functions/mcp/index.ts:26-31` — `constantTimeEqual` helper.
- `supabase/functions/mcp/server.ts:22` — `PLANNEN_USER_EMAIL` env read.
- `supabase/functions/mcp/server.ts:23-29` — module-level `_userId` singleton and `uid()` function.

### New per-request flow

```ts
// supabase/functions/mcp/index.ts
export function authenticate(req: Request): { bearer: string } | Response {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return reply401('missing_bearer')
  const bearer = header.slice(7)
  if (!bearer.startsWith('plnnn_')) return reply401('invalid_token_format')
  return { bearer }
}

// supabase/functions/mcp/server.ts (per-request)
const auth = authenticate(req)
if (auth instanceof Response) return auth

const client = await pool.connect()
try {
  // 1. Resolve token → user_id. Pre-auth lookup as the service connection.
  const userId = await resolveTokenToUserId(client, auth.bearer)
  if (!userId) return reply401('invalid_token')

  // 2. Open the tool transaction with the resolved identity.
  await client.query('BEGIN')
  await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])

  const result = await handler(req.params.arguments ?? {}, { client, userId })
  await client.query('COMMIT')
  return result
} catch (e) {
  await client.query('ROLLBACK')
  return errorResponse(e)
} finally {
  client.release()
}
```

### `resolveTokenToUserId` — single roundtrip

```ts
export async function resolveTokenToUserId(
  client: PoolClient, plaintext: string,
): Promise<string | null> {
  const hash = createHash('sha256').update(plaintext).digest()
  const { rows } = await client.query<{ user_id: string }>(
    `UPDATE plannen.user_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING user_id`,
    [hash],
  )
  return rows[0]?.user_id ?? null
}
```

One indexed query, hits the unique `user_tokens_token_hash_idx`. Updates `last_used_at` as a side effect. Expired or unknown tokens return zero rows.

No in-memory cache in v1 — table is tiny, index lookup is sub-millisecond, accuracy on `last_used_at` matters more. Profile and revisit if hot-path latency becomes an issue.

### Failure modes

| Condition | Status | Body |
|-----------|--------|------|
| No `Authorization` header | 401 | `{"error": "missing_bearer"}` |
| Header doesn't start with `Bearer ` | 401 | `{"error": "missing_bearer"}` |
| Bearer doesn't match `plnnn_` prefix | 401 | `{"error": "invalid_token_format"}` |
| Token hash not in DB, or expired | 401 | `{"error": "invalid_token"}` |
| DB unreachable | 500 | `{"error": "internal"}` |

Timing-attack window is negligible: ~microsecond differences across a network round-trip against a 256-bit token space.

## Tier 1 vs Tier 2

| Concern | Tier 1 (local Docker) | Tier 2 (cloud) |
|---|---|---|
| `mcp` function | `supabase functions serve` | `supabase functions deploy mcp` |
| New `mcp-token` function | Served locally | Deployed alongside `mcp` |
| `user_tokens` table | Local Postgres | Cloud Supabase Postgres |
| Migration applied via | `npx plannen migrate` (tier-aware runner) | `supabase db push --project-ref` (same runner, cloud branch) |
| Web UI | `npm run dev` on `:4321` | Vercel deployment at `PLANNEN_WEB_URL` |
| Admin auto-mint | Dev runs `plannen token create` after `plannen up` | `plannen cloud provision` mints automatically |

No code branches on tier. Tier 1 vs Tier 2 is purely a deployment target — same code, same SQL, different connection strings.

## Migration story (breaking)

Any deployment running `MCP_BEARER_TOKEN` today upgrades in five commands:

1. `git pull`
2. `npx plannen migrate` — applies the new table + RLS.
3. `npx plannen functions deploy` — pushes updated `mcp` and new `mcp-token`.
4. `npx plannen token create --label "$(hostname)"` — mints admin's first PAT, replaces the shared-bearer value in profile env, rewrites plugin.json.
5. Reload the plannen plugin in Claude Code.

Tidy-up (optional): `supabase secrets unset MCP_BEARER_TOKEN --project-ref <ref>` removes the old cloud secret. The function no longer reads it; leaving it has no effect.

For invited users joining an existing deployment:

1. Admin shares the deployment's `SUPABASE_URL` + anon key.
2. User runs `plannen profile create --mode cloud_sb`, signs in via magic link at the deployment's web URL.
3. `/settings` → "Personal access tokens" → Generate, save plaintext.
4. `plannen token activate <PAT>` — wires their profile env + plugin.json.

## Testing

Layout mirrors existing patterns: edge-function vitest+deno-shim, CLI vitest with mocked spawn + tmpfs HOME.

**Migration tests** (`supabase/functions/_shared/db.test.ts` or new file):
- Table exists with expected columns + types.
- Unique index on `token_hash`.
- RLS policies enforce `user_id = auth.uid()` for SELECT/INSERT/DELETE.
- Cascade delete fires when parent user is removed.

**`_shared/userTokens.ts` helper** (`supabase/functions/_shared/userTokens.test.ts`):
- `mintToken`: returns `plnnn_…`, stores sha-256 in `token_hash`, stores first-12-chars in `prefix`, distinct on repeat mint, rejects empty/whitespace label, honors `expires_at`.
- `listTokens`: caller-scoped, never returns plaintext or hash, newest-first.
- `revokeToken`: deletes on `(user_id, id)` match, returns false for cross-user attempts.
- `resolveTokenToUserId`: returns user_id on valid token, null on unknown, null on expired, updates `last_used_at` on success, does not update on failure.

**`mcp-token` function** (`supabase/functions/mcp-token/index.test.ts`):
- POST without/invalid JWT → 401.
- POST with valid JWT + valid body → 200, plaintext in response once.
- POST with empty label → 400.
- GET returns caller's rows (no plaintext).
- DELETE of own id → 204, row gone.
- DELETE of another user's id → 404.

**`mcp` function** (`supabase/functions/mcp/index.test.ts`, updated):
- Remove all `MCP_BEARER_TOKEN` env assertions.
- New: 401 paths (missing header, bad shape, bad prefix, invalid token, expired token).
- **Multi-user isolation regression**: mint PATs for User A and User B; fire alternating `tools/call` requests against the same server instance; assert each handler received the correct `userId` in `ctx`. This is the test that fails if anyone reintroduces the module-level cache.
- `last_used_at` moves forward on each successful call.

**CLI verbs** (`cli/__tests__/token-*.test.mjs`):
- `token-create`: resolves user from active profile, INSERTs (mocked), writes profile env, rewrites plugin.json, output includes plaintext + warning; `--no-activate` skips side effects.
- `token-list`: tabular output, no plaintext.
- `token-revoke`: DELETE invoked with `(user_id, id)`, error message on mismatched id.
- `token-activate`: no DB call, validates prefix, writes profile env, rewrites plugin.json.

**Cloud provision** (`cli/__tests__/cloud-provision.test.mjs`, updated):
- Current assertion `profEnv.MCP_BEARER_TOKEN === 'bearer-xyz'` becomes "starts with `plnnn_`".
- Assert a row exists in `plannen.user_tokens` for the admin email with label `"provision-<hostname>"`.

**Web UI** (`/settings` panel):
- Smoke-level following the project's existing web test pattern. Happy path: render, click Generate, fill label, submit, assert plaintext shown once, dismiss, assert it doesn't reappear. Revoke: click revoke, confirm, assert row gone.

**Not tested in this PR:**
- Timing-attack resistance (structural, not asserted).
- `last_used_at` write contention under load (Postgres handles row locks; no load test here).
- Mint endpoint flood (rate-limit is a follow-up).

## File layout summary

New:
```
supabase/migrations/YYYYMMDDHHMMSS_user_tokens.sql
supabase/functions/_shared/userTokens.ts
supabase/functions/_shared/userTokens.test.ts
supabase/functions/mcp-token/index.ts
supabase/functions/mcp-token/index.test.ts
scripts/lib/userTokens.mjs                  (Node twin of the helper)
scripts/lib/userTokens.test.mjs
cli/commands/token/create.mjs
cli/commands/token/list.mjs
cli/commands/token/revoke.mjs
cli/commands/token/activate.mjs
cli/commands/token/rotate.mjs
cli/__tests__/token-create.test.mjs
cli/__tests__/token-list.test.mjs
cli/__tests__/token-revoke.test.mjs
cli/__tests__/token-activate.test.mjs
cli/__tests__/token-rotate.test.mjs
src/components/SettingsTokens.tsx           (web UI panel, mounted from Settings.tsx)
```

Modified:
```
supabase/functions/mcp/index.ts             (authenticate rewritten)
supabase/functions/mcp/server.ts            (remove singleton, per-request resolve)
supabase/functions/mcp/index.test.ts        (PAT auth + multi-user isolation)
cli/index.mjs                               (wire token verbs)
cli/commands/cloud/provision.mjs            (auto-mint replaces shared bearer)
cli/__tests__/cloud-provision.test.mjs      (updated assertion)
src/components/Settings.tsx                 (mount SettingsTokens panel)
README.md                                   (PAT setup section)
CHANGELOG.md                                (0.6.0 breaking entry)
package.json                                (0.5.x → 0.6.0)
```

Deleted:
```
scripts/mcp-rotate-bearer.sh
scripts/lib/mcp-rotate-bearer.mjs
```

## Open follow-ups (out of scope)

- Rate-limiting the mint endpoint (`POST /functions/v1/mcp-token`). A user with a valid session could spam-mint; cheap to fix later with Supabase rate limits or a per-user-per-minute check.
- Extending PAT auth to non-MCP edge functions. Refactor `_shared/jwt.ts` into `_shared/auth.ts` that tries PAT first then falls back to JWT. Worth doing once a second caller wants it.
- An in-memory `token_hash → user_id` cache in the MCP function with ~60s TTL, if profiling reveals the DB lookup is a hot-path bottleneck.
- An "audit log" view: who minted what, when, last used from where. Could be derived from a small additions to the schema (`created_from_ip`, `last_used_ip`) if it ever matters.

## Decisions left explicit

Items the user actively chose during brainstorming:

- Scope: tier 1 + tier 2. Tier 0 stays single-user.
- Issuance UX: web UI primary; CLI shortcut for admins added on user push-back ("CLI user has DB access anyway").
- Existing shared `MCP_BEARER_TOKEN`: removed entirely, no break-glass path.
- Tokens per user: many, named, like GitHub.
- CLI mint owner: the active profile's `PLANNEN_USER_EMAIL`, no `--for` flag in v1.
