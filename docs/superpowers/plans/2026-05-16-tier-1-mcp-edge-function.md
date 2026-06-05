# Tier 1 MCP-as-Edge-Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Plannen MCP server from a Node stdio subprocess (`mcp/src/`) to a Supabase Edge Function (`supabase/functions/mcp/`) speaking MCP's `StreamableHTTPServerTransport`, running locally via `supabase functions serve mcp`. Drop `transcribe_memory` (no `child_process` in Deno). Ship a `scripts/mcp-mode.sh` helper that toggles the plugin between stdio and HTTP modes.

**Architecture:** New parallel MCP implementation alongside the Node one. The Deno port reuses `supabase/functions/_shared/db.ts` (`withDb` GUC pattern + `npm:pg@8`) verbatim; tool surface mirrors the Node MCP minus `transcribe_memory`; auth is a single shared `MCP_BEARER_TOKEN` (multi-user is a separate future phase). Tools live in `supabase/functions/mcp/tools/<domain>.ts` files (one per logical group) rather than a single 2,000-line file.

**Tech Stack:** Deno + `@modelcontextprotocol/sdk@^1` + `npm:pg@8` + `npm:zod@3`. Tests run via vitest in Node using the existing alias config at `supabase/functions/vitest.config.ts` (rewrites `npm:` specifiers to bare names — handler files are runtime-agnostic).

**Spec:** [`../specs/2026-05-16-tier-1-mcp-edge-function-design.md`](../specs/2026-05-16-tier-1-mcp-edge-function-design.md)

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/functions/mcp/index.ts` *(new)* | Edge Function entry. HTTP server boundary, bearer auth, transport hookup. |
| `supabase/functions/mcp/server.ts` *(new)* | Constructs the MCP `Server`; aggregates tool definitions + dispatch from `tools/*.ts`; resolves the bootstrap user once at module load. |
| `supabase/functions/mcp/types.ts` *(new)* | Shared `ToolCtx`, `ToolModule`, and helper types used by every `tools/<domain>.ts`. |
| `supabase/functions/mcp/tools/events.ts` *(new)* | `list_events`, `get_event`, `create_event`, `update_event`, `rsvp_event` (5 tools). |
| `supabase/functions/mcp/tools/memories.ts` *(new)* | `add_event_memory`, `list_event_memories` (2 tools; `transcribe_memory` dropped). |
| `supabase/functions/mcp/tools/stories.ts` *(new)* | `create_story`, `update_story`, `get_story`, `list_stories`, `delete_story` (5 tools). |
| `supabase/functions/mcp/tools/photos.ts` *(new)* | `create_photo_picker_session`, `poll_photo_picker_session` (2 tools). |
| `supabase/functions/mcp/tools/gcal.ts` *(new)* | `get_gcal_sync_candidates`, `set_gcal_event_id` (2 tools). |
| `supabase/functions/mcp/tools/relationships.ts` *(new)* | `list_relationships` (1 tool). |
| `supabase/functions/mcp/tools/profile.ts` *(new)* | `get_profile_context`, `update_profile`, `get_story_languages`, `set_story_languages` (4 tools). |
| `supabase/functions/mcp/tools/family.ts` *(new)* | `add_family_member`, `list_family_members` (2 tools). |
| `supabase/functions/mcp/tools/locations.ts` *(new)* | `add_location`, `list_locations` (2 tools). |
| `supabase/functions/mcp/tools/watches.ts` *(new)* | `get_event_watch_task`, `get_watch_queue`, `update_watch_task`, `create_watch_task` (4 tools). |
| `supabase/functions/mcp/tools/sources.ts` *(new)* | `save_source`, `update_source`, `get_unanalysed_sources`, `search_sources` (4 tools). |
| `supabase/functions/mcp/tools/profileFacts.ts` *(new)* | `list_profile_facts`, `get_historical_facts`, `correct_profile_fact`, `upsert_profile_fact` (4 tools). |
| `supabase/functions/mcp/tools/<domain>.test.ts` *(new, 12 files)* | One test file per domain. Shape tests + dispatch tests using a mock `ToolCtx`. |
| `supabase/functions/mcp/deno.json` *(new)* | Deno config + npm-specifier import map. |
| `supabase/functions/vitest.config.ts` *(modify)* | Add `mcp/**/*.test.ts` to the `include` array. |
| `scripts/mcp-mode.sh` *(new)* | Toggles `plugin/.claude-plugin/plugin.json` between stdio and HTTP MCP entries; generates and persists a bearer token. |
| `tests/smoke/tier1-http-mcp.sh` *(new)* | End-to-end smoke: `local-start` → `mcp-mode.sh http` → `functions serve` → `curl tools/list` → tear down. |
| `plugin/commands/plannen-doctor.md` *(modify)* | Add an MCP-mode detection line. |
| `README.md` *(modify)* | New "Run with HTTP MCP (opt-in)" subsection. |
| `CONTRIBUTING.md` *(modify)* | Dev-flow update covering `mcp-mode.sh`. |
| `.github/workflows/test.yml` *(modify, if it exists)* | Add a vitest job for `supabase/functions/mcp/`. Already covered by the existing `supabase/functions` vitest config once we update its `include`. |
| `plugin/.claude-plugin/plugin.json` | **Unchanged in git.** `mcp-mode.sh` rewrites it locally on each install. |
| `mcp/src/*` | **Unchanged.** Stays the canonical Tier 0 / Tier 1-stdio MCP. |

Total new files: **27**. Total modified files: **4-5**.

---

## Task 1 — Scaffold the Deno MCP project

**Files:**
- Create: `supabase/functions/mcp/deno.json`
- Create: `supabase/functions/mcp/index.ts` (minimal health-check)
- Create: `supabase/functions/mcp/types.ts`
- Modify: `supabase/functions/vitest.config.ts` (line 17, `include` array)

- [ ] **Step 1: Create `supabase/functions/mcp/deno.json`**

```json
{
  "imports": {
    "@modelcontextprotocol/sdk/": "npm:@modelcontextprotocol/sdk@^1/",
    "pg": "npm:pg@8",
    "zod": "npm:zod@3"
  },
  "lint": { "rules": { "tags": ["recommended"] } },
  "fmt": { "options": { "useTabs": false, "indentWidth": 2, "singleQuote": true, "semiColons": false } }
}
```

- [ ] **Step 2: Create `supabase/functions/mcp/types.ts`**

```ts
import type { PoolClient } from 'npm:pg@8'

export interface ToolCtx {
  /** Postgres client checked out from the pool, inside withDb's transaction. */
  client: PoolClient
  /** Bootstrap user resolved at module load via PLANNEN_USER_EMAIL. */
  userId: string
}

export type ToolHandler = (args: unknown, ctx: ToolCtx) => Promise<unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolModule {
  definitions: ToolDefinition[]
  dispatch: Record<string, ToolHandler>
}
```

- [ ] **Step 3: Create `supabase/functions/mcp/index.ts` (minimal placeholder)**

```ts
// Entry point for Plannen MCP HTTP server.
// Tasks 2+ wire up bearer auth and the MCP transport. This stub exists so
// `supabase functions serve mcp` boots cleanly during scaffold.

Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({ status: 'scaffold', message: 'MCP function not yet wired' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
```

- [ ] **Step 4: Update `supabase/functions/vitest.config.ts` to include the new test directory**

Change line 17 from:

```ts
    include: ['_shared/handlers/**/*.test.ts'],
```

to:

```ts
    include: ['_shared/handlers/**/*.test.ts', 'mcp/**/*.test.ts'],
```

- [ ] **Step 5: Verify `supabase functions serve mcp` starts (local Supabase must already be running)**

Run: `bash scripts/local-start.sh` (in one terminal, if not already running)
Run: `supabase functions serve mcp` (in another terminal)
Run: `curl -s http://127.0.0.1:54321/functions/v1/mcp`
Expected output: `{"status":"scaffold","message":"MCP function not yet wired"}`
Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/deno.json supabase/functions/mcp/index.ts supabase/functions/mcp/types.ts supabase/functions/vitest.config.ts
git commit -m "scaffold: empty supabase/functions/mcp/ skeleton"
```

---

## Task 2 — HTTP transport + bearer auth

Wire MCP's `StreamableHTTPServerTransport` into the Edge Function entry, with bearer-token validation up front.

**Files:**
- Modify: `supabase/functions/mcp/index.ts`
- Create: `supabase/functions/mcp/index.test.ts`

- [ ] **Step 1: Write the failing test for bearer auth**

Create `supabase/functions/mcp/index.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { authenticate } from './index.ts'

describe('authenticate', () => {
  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = 'test-token-abc'
  })

  it('returns null when Authorization header matches', () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer test-token-abc' },
    })
    expect(authenticate(req)).toBeNull()
  })

  it('returns 401 when Authorization header is missing', () => {
    const req = new Request('http://x/')
    const res = authenticate(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('returns 401 when bearer is wrong', () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    const res = authenticate(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('uses constant-time compare (no early return on length mismatch)', () => {
    // Same length as test-token-abc (14 chars) so length matches but content doesn't.
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wronglongabc1' },
    })
    expect(authenticate(req)!.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts`
Expected: All four tests fail with `authenticate is not a function` or similar.

- [ ] **Step 3: Implement `authenticate` in `supabase/functions/mcp/index.ts`**

Replace the placeholder content with:

```ts
// Entry point for Plannen MCP HTTP server.
// Validates bearer auth, then hands off to the MCP server (Task 3+ wires the
// transport). Bearer is the shared MCP_BEARER_TOKEN env (single-user in Phase
// A; per-user tokens land in Phase A.1).

/**
 * Constant-time compare to avoid timing oracles on the bearer token.
 * Returns true if equal, false otherwise (including length mismatch).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Returns null when the request's bearer matches MCP_BEARER_TOKEN.
 * Returns a 401 Response otherwise.
 */
export function authenticate(req: Request): Response | null {
  const expected = (typeof Deno !== 'undefined' ? Deno.env.get('MCP_BEARER_TOKEN') : process.env.MCP_BEARER_TOKEN) ?? ''
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) {
    return new Response(JSON.stringify({ error: 'missing_bearer' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const supplied = header.slice(prefix.length)
  if (!expected || !constantTimeEqual(supplied, expected)) {
    return new Response(JSON.stringify({ error: 'invalid_bearer' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

Deno.serve(async (req: Request) => {
  const authFailed = authenticate(req)
  if (authFailed) return authFailed
  // Task 3 wires the MCP transport here. Placeholder ack for now.
  return new Response(
    JSON.stringify({ status: 'authenticated', message: 'MCP transport not yet wired' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts`
Expected: All four tests pass.

- [ ] **Step 5: Manual smoke check (optional but recommended)**

Run: `MCP_BEARER_TOKEN=test-token supabase functions serve mcp` (in one terminal)
Run: `curl -s -H "Authorization: Bearer test-token" http://127.0.0.1:54321/functions/v1/mcp`
Expected: `{"status":"authenticated","message":"MCP transport not yet wired"}`
Run: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:54321/functions/v1/mcp`
Expected: `401`

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/index.ts supabase/functions/mcp/index.test.ts
git commit -m "feat(mcp): bearer-auth middleware on the edge function entry"
```

---

## Task 3 — MCP Server + StreamableHTTPServerTransport + bootstrap user

Wire the MCP SDK's HTTP transport into the request flow. The server starts empty (no tools yet) — Task 4+ populates it. This task proves the transport hookup works end-to-end with `tools/list` returning `[]`.

**Files:**
- Create: `supabase/functions/mcp/server.ts`
- Modify: `supabase/functions/mcp/index.ts`
- Modify: `supabase/functions/mcp/index.test.ts` (add transport-level test)

- [ ] **Step 1: Write the failing test for an empty `tools/list` response**

Append to `supabase/functions/mcp/index.test.ts`:

```ts
import { handleRequest } from './index.ts'

describe('handleRequest (transport)', () => {
  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = 'test-token-abc'
    process.env.PLANNEN_USER_EMAIL = 'test@example.com'
  })

  it('responds to tools/list with an empty list when no tool modules are registered', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token-abc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result?.tools).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts`
Expected: New test fails with `handleRequest is not a function`.

- [ ] **Step 3: Create `supabase/functions/mcp/server.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Pool } from 'npm:pg@8'
import { resolveUserIdByEmail } from '../_shared/userResolver.ts'
import type { ToolModule } from './types.ts'

const pool = new Pool({ connectionString: Deno.env.get('DATABASE_URL') ?? '' })

const USER_EMAIL = (Deno.env.get('PLANNEN_USER_EMAIL') ?? '').toLowerCase()
let _userId: string | null = null

async function uid(): Promise<string> {
  if (_userId) return _userId
  _userId = await resolveUserIdByEmail(pool, USER_EMAIL)
  return _userId
}

/**
 * Build a Server with the supplied tool modules wired in. Exported so tests
 * can construct it with zero or partial modules.
 */
export function buildServer(modules: ToolModule[]) {
  const server = new Server(
    { name: 'plannen', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const definitions = modules.flatMap((m) => m.definitions)
  const dispatch: Record<string, ToolModule['dispatch'][string]> = {}
  for (const m of modules) Object.assign(dispatch, m.dispatch)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = dispatch[req.params.name]
    if (!handler) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      }
    }
    const userId = await uid()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
      const result = await handler(req.params.arguments ?? {}, { client, userId })
      await client.query('COMMIT')
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      await client.query('ROLLBACK')
      const msg = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: msg }], isError: true }
    } finally {
      client.release()
    }
  })

  return server
}

export { pool }
```

- [ ] **Step 4: Create `supabase/functions/_shared/userResolver.ts`** (mirrors `mcp/src/userResolver.ts` but Deno-shape)

```ts
import type { Pool } from 'npm:pg@8'

export async function resolveUserIdByEmail(pool: Pool, email: string): Promise<string> {
  if (!email) throw new Error('PLANNEN_USER_EMAIL is required')
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM auth.users WHERE lower(email) = $1 LIMIT 1',
    [email.toLowerCase()],
  )
  if (rows.length === 0) throw new Error(`no auth.users row for ${email}`)
  return rows[0].id
}
```

- [ ] **Step 5: Rewrite `supabase/functions/mcp/index.ts` to use the SDK's HTTP transport**

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from './server.ts'
import type { ToolModule } from './types.ts'

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function authenticate(req: Request): Response | null {
  const expected = (typeof Deno !== 'undefined' ? Deno.env.get('MCP_BEARER_TOKEN') : process.env.MCP_BEARER_TOKEN) ?? ''
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) {
    return new Response(JSON.stringify({ error: 'missing_bearer' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }
  const supplied = header.slice(prefix.length)
  if (!expected || !constantTimeEqual(supplied, expected)) {
    return new Response(JSON.stringify({ error: 'invalid_bearer' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

/**
 * Test-injectable wrapper. In production handleRequest is called with the
 * module-loaded tool list; tests pass {tools: []} to verify the transport
 * shape independently of the tool catalogue.
 */
export async function handleRequest(
  req: Request,
  opts: { tools: ToolModule[] } = { tools: [] },
): Promise<Response> {
  const authFailed = authenticate(req)
  if (authFailed) return authFailed

  const server = buildServer(opts.tools)
  const transport = new StreamableHTTPServerTransport()
  await server.connect(transport)
  return await transport.handleRequest(req)
}

// Module-level tool registry. Populated by future tasks (Task 4+).
const TOOLS: ToolModule[] = []

if (typeof Deno !== 'undefined') {
  Deno.serve((req) => handleRequest(req, { tools: TOOLS }))
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd supabase/functions && npx vitest run mcp/index.test.ts`
Expected: All tests pass, including the new transport test.

- [ ] **Step 7: Manual smoke**

Run (in one terminal): `MCP_BEARER_TOKEN=test-token PLANNEN_USER_EMAIL=$(grep PLANNEN_USER_EMAIL .env | cut -d= -f2) supabase functions serve mcp`
Run: `curl -s -X POST -H "Authorization: Bearer test-token" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' http://127.0.0.1:54321/functions/v1/mcp`
Expected: `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/mcp/server.ts supabase/functions/mcp/index.ts supabase/functions/mcp/index.test.ts supabase/functions/_shared/userResolver.ts
git commit -m "feat(mcp): wire StreamableHTTPServerTransport with empty tool registry"
```

---

## Task 4 — `scripts/mcp-mode.sh` helper

Toggle the plugin manifest between stdio and HTTP MCP. The script is the user-facing UX for switching modes; downstream tasks assume `mcp-mode.sh http` has been run.

**Files:**
- Create: `scripts/mcp-mode.sh`
- Create: `scripts/mcp-mode.test.sh` (bash test harness)

- [ ] **Step 1: Write the test harness**

Create `scripts/mcp-mode.test.sh`:

```bash
#!/usr/bin/env bash
# Smoke tests for scripts/mcp-mode.sh. Uses a temp dir as a fake repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stage a fake plugin.json and supabase/ env layout.
mkdir -p "$TMP/plugin/.claude-plugin" "$TMP/supabase"
cat > "$TMP/plugin/.claude-plugin/plugin.json" <<EOF
{
  "name": "plannen",
  "version": "0.1.0",
  "mcpServers": {
    "plannen": { "command": "node", "args": ["\${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js"] }
  }
}
EOF

# --- Test 1: switch to http generates bearer and rewrites plugin.json ---
bash "$REPO_ROOT/scripts/mcp-mode.sh" http --root "$TMP" >/dev/null
grep -q '"type": "http"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json missing http type"; exit 1; }
grep -q 'Bearer ' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json missing Bearer header"; exit 1; }
grep -q '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" \
  || { echo "FAIL: supabase/.env.local missing MCP_BEARER_TOKEN"; exit 1; }

# --- Test 2: re-running http preserves the existing bearer ---
TOKEN_BEFORE=$(grep '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" | cut -d= -f2)
bash "$REPO_ROOT/scripts/mcp-mode.sh" http --root "$TMP" >/dev/null
TOKEN_AFTER=$(grep '^MCP_BEARER_TOKEN=' "$TMP/supabase/.env.local" | cut -d= -f2)
[ "$TOKEN_BEFORE" = "$TOKEN_AFTER" ] \
  || { echo "FAIL: bearer rotated on re-run (idempotency broken)"; exit 1; }

# --- Test 3: switch to stdio restores the stdio entry ---
bash "$REPO_ROOT/scripts/mcp-mode.sh" stdio --root "$TMP" >/dev/null
grep -q '"command": "node"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json did not restore stdio entry"; exit 1; }
! grep -q '"type": "http"' "$TMP/plugin/.claude-plugin/plugin.json" \
  || { echo "FAIL: plugin.json still has http entry after stdio switch"; exit 1; }

echo "OK"
```

```bash
chmod +x scripts/mcp-mode.test.sh
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bash scripts/mcp-mode.test.sh`
Expected: `bash: scripts/mcp-mode.sh: No such file or directory`

- [ ] **Step 3: Implement `scripts/mcp-mode.sh`**

```bash
#!/usr/bin/env bash
# Toggle the plannen plugin's MCP entry between stdio (default, Node-based)
# and HTTP (new in Phase A, Edge Function based).
#
#   bash scripts/mcp-mode.sh stdio
#   bash scripts/mcp-mode.sh http
#
# Flags:
#   --root <path>   Override repo root (used by tests; defaults to script's parent).

set -euo pipefail

MODE="${1:-}"
shift || true

ROOT_DEFAULT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$ROOT_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

PLUGIN_JSON="$ROOT/plugin/.claude-plugin/plugin.json"
ENV_FILE="$ROOT/supabase/.env.local"
HTTP_URL="http://127.0.0.1:54321/functions/v1/mcp"

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "plugin.json not found at $PLUGIN_JSON" >&2
  exit 1
fi

case "$MODE" in
  http)
    mkdir -p "$(dirname "$ENV_FILE")"
    if [ -f "$ENV_FILE" ] && grep -q '^MCP_BEARER_TOKEN=' "$ENV_FILE"; then
      TOKEN=$(grep '^MCP_BEARER_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2)
    else
      TOKEN=$(openssl rand -hex 32)
      touch "$ENV_FILE"
      # Strip any partial line then append.
      grep -v '^MCP_BEARER_TOKEN=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
      mv "$ENV_FILE.tmp" "$ENV_FILE"
      echo "MCP_BEARER_TOKEN=$TOKEN" >> "$ENV_FILE"
    fi

    # Rewrite plugin.json.mcpServers.plannen to the HTTP entry. node -e keeps
    # JSON formatting predictable across systems where jq may not be installed.
    node -e "
      const fs = require('fs');
      const path = '$PLUGIN_JSON';
      const j = JSON.parse(fs.readFileSync(path, 'utf8'));
      j.mcpServers = j.mcpServers || {};
      j.mcpServers.plannen = {
        type: 'http',
        url: '$HTTP_URL',
        headers: { Authorization: 'Bearer $TOKEN' },
      };
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    echo "→ HTTP MCP configured. Reload the plannen plugin in Claude Code to apply."
    ;;

  stdio)
    node -e "
      const fs = require('fs');
      const path = '$PLUGIN_JSON';
      const j = JSON.parse(fs.readFileSync(path, 'utf8'));
      j.mcpServers = j.mcpServers || {};
      j.mcpServers.plannen = {
        command: 'node',
        args: ['\${CLAUDE_PLUGIN_ROOT}/../mcp/dist/index.js'],
      };
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    echo "→ stdio MCP configured. Reload the plannen plugin in Claude Code to apply."
    ;;

  *)
    cat <<EOF
Usage: $0 stdio|http [--root <path>]

  stdio   Restore the default Node-stdio MCP entry in plugin.json.
  http    Generate a bearer token (or reuse the existing one), write it to
          supabase/.env.local, rewrite plugin.json's mcpServers.plannen entry
          to point at the local HTTP Edge Function MCP.
EOF
    exit 1
    ;;
esac
```

```bash
chmod +x scripts/mcp-mode.sh
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash scripts/mcp-mode.test.sh`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/mcp-mode.sh scripts/mcp-mode.test.sh
git commit -m "feat(mcp): scripts/mcp-mode.sh helper toggles plugin between stdio and http"
```

---

## Task 5 — Port `events` domain (worked-example template)

This task is the **template for all subsequent port tasks (Tasks 6-16).** It walks through porting one domain in full TDD detail. Later tasks reference this one's pattern and provide only the per-domain specifics.

**Source tools (in `mcp/src/index.ts`):**

| Tool | Schema line range | Handler function name | Handler line range |
|---|---|---|---|
| `list_events` | 1585-1602 | `listEvents` | search `function listEvents` in file |
| `get_event` | 1603-1614 | `getEvent` | search `function getEvent` |
| `create_event` | 1615-1646 | `createEvent` | search `function createEvent` |
| `update_event` | 1647-1665 | `updateEvent` | search `function updateEvent` |
| `rsvp_event` | 1666-1677 | `rsvpEvent` | search `function rsvpEvent` |

**Files:**
- Create: `supabase/functions/mcp/tools/events.ts`
- Create: `supabase/functions/mcp/tools/events.test.ts`
- Modify: `supabase/functions/mcp/index.ts` (add events module to TOOLS array)

- [ ] **Step 1: Open `mcp/src/index.ts` and locate the events tool definitions and handlers**

Skim lines 1585-1677 for the schemas, then `grep -n "function listEvents\|function getEvent\|function createEvent\|function updateEvent\|function rsvpEvent" mcp/src/index.ts` to find the handler bodies. Read each handler in full — you'll port them mechanically in Step 4.

- [ ] **Step 2: Write the failing test file `supabase/functions/mcp/tools/events.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { eventsModule } from './events.ts'

describe('events module', () => {
  it('registers exactly 5 tool definitions', () => {
    expect(eventsModule.definitions).toHaveLength(5)
  })

  it('definitions cover the expected tool names', () => {
    const names = eventsModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_event', 'get_event', 'list_events', 'rsvp_event', 'update_event'])
  })

  it('every definition name has a matching dispatch entry', () => {
    for (const def of eventsModule.definitions) {
      expect(typeof eventsModule.dispatch[def.name]).toBe('function')
    }
  })

  it('list_events dispatch executes a parameterised query against ctx.client', async () => {
    const queries: { sql: string; params: unknown[] }[] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    await eventsModule.dispatch.list_events({}, ctx)
    expect(queries.length).toBeGreaterThan(0)
    // First substantive query should target plannen.events; exact SQL belongs
    // to the port and may be tweaked, so we only assert the table.
    const sqlBlob = queries.map((q) => q.sql).join(' ')
    expect(sqlBlob).toMatch(/plannen\.events/i)
  })

  it('create_event rejects missing title', async () => {
    const ctx = { client: { query: async () => ({ rows: [], rowCount: 0 }) } as any, userId: 'u1' }
    await expect(
      eventsModule.dispatch.create_event({ start_date: '2026-06-15T10:00:00Z' }, ctx),
    ).rejects.toThrow(/title/i)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd supabase/functions && npx vitest run mcp/tools/events.test.ts`
Expected: All tests fail with `Cannot find module './events.ts'`.

- [ ] **Step 4: Port the events tools to `supabase/functions/mcp/tools/events.ts`**

Create the file. Copy each tool's schema verbatim from `mcp/src/index.ts:1585-1677` into the `definitions` array. Then port each handler function from `mcp/src/index.ts` — find each one with grep, copy the body, and adapt:

- `process.env.X` → `Deno.env.get('X')` (none expected in event handlers, but check)
- Top-level `pool.connect()` → use `ctx.client` (already inside a transaction set up by `server.ts`)
- `uid()` calls → use `ctx.userId` directly
- Argument typing → cast `args as { … }` matching the schema

Resulting structure (one example handler shown in full; port the other four following the same pattern):

```ts
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

const definitions: ToolDefinition[] = [
  {
    name: 'list_events',
    description: 'List your events in Plannen. Returns a slim row by default; description is truncated to 200 chars + ellipsis. Pass fields:"full" if you need the untruncated description.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'],
          description: 'Filter by status (omit for all)',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
        from_date: { type: 'string', description: 'ISO date to filter events starting on or after this date, e.g. 2026-05-07' },
        to_date: { type: 'string', description: 'ISO date to filter events starting on or before this date, e.g. 2026-05-07' },
        fields: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) truncates description to 200 chars; full returns the untruncated description.' },
      },
    },
  },
  // ... paste schemas for get_event, create_event, update_event, rsvp_event from mcp/src/index.ts:1603-1677
]

// Worked example: port of `listEvents` from mcp/src/index.ts.
// Adapt by replacing `pool.connect()` boilerplate with the ctx.client passed in.
const listEvents: ToolHandler = async (args, ctx) => {
  const a = args as { status?: string; limit?: number; from_date?: string; to_date?: string; fields?: string }
  const limit = a.limit ?? 10
  const slimCols = 'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags'
  const fullCols = '*'
  const cols = a.fields === 'full' ? fullCols : slimCols

  const conditions: string[] = ['user_id = $1']
  const params: unknown[] = [ctx.userId]
  if (a.status) { conditions.push(`event_status = $${params.length + 1}`); params.push(a.status) }
  if (a.from_date) { conditions.push(`start_date >= $${params.length + 1}`); params.push(a.from_date) }
  if (a.to_date) { conditions.push(`start_date <= $${params.length + 1}`); params.push(a.to_date) }
  params.push(limit)

  const sql = `
    SELECT ${cols} FROM plannen.events
    WHERE ${conditions.join(' AND ')}
    ORDER BY start_date DESC
    LIMIT $${params.length}
  `
  const { rows } = await ctx.client.query(sql, params)

  if (a.fields !== 'full') {
    for (const r of rows as { description?: string }[]) {
      if (r.description && r.description.length > 200) r.description = r.description.slice(0, 200) + '…'
    }
  }
  return { events: rows }
}

// ... port getEvent, createEvent, updateEvent, rsvpEvent the same way.
// The handlers in mcp/src/index.ts use a top-level `pool` and call `uid()`;
// here they receive ctx.client (already inside a transaction) and ctx.userId.

const createEvent: ToolHandler = async (args, ctx) => {
  const a = args as { title?: string; start_date?: string; /* … */ }
  if (!a.title) throw new Error('title is required')
  if (!a.start_date) throw new Error('start_date is required')
  // ... rest of port from mcp/src/index.ts's createEvent function
  throw new Error('PORT INCOMPLETE')  // remove after porting; placeholder so types compile
}

// Placeholders for the remaining three; replace with ports from mcp/src/index.ts.
const getEvent: ToolHandler = async () => { throw new Error('PORT INCOMPLETE') }
const updateEvent: ToolHandler = async () => { throw new Error('PORT INCOMPLETE') }
const rsvpEvent: ToolHandler = async () => { throw new Error('PORT INCOMPLETE') }

export const eventsModule: ToolModule = {
  definitions,
  dispatch: {
    list_events: listEvents,
    get_event: getEvent,
    create_event: createEvent,
    update_event: updateEvent,
    rsvp_event: rsvpEvent,
  },
}
```

Then go back and replace the `throw new Error('PORT INCOMPLETE')` placeholders with the actual ported handler bodies. Each port is a mechanical translation — read the Node version, rewrite using `ctx.client` instead of pool checkouts and `ctx.userId` instead of `await uid()`.

- [ ] **Step 5: Wire the module into the top-level TOOLS list**

In `supabase/functions/mcp/index.ts`, replace:

```ts
const TOOLS: ToolModule[] = []
```

with:

```ts
import { eventsModule } from './tools/events.ts'
const TOOLS: ToolModule[] = [eventsModule]
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd supabase/functions && npx vitest run mcp/tools/events.test.ts`
Expected: All five tests pass.

- [ ] **Step 7: Integration smoke (optional but recommended)**

Run (in one terminal): `supabase functions serve mcp --env-file supabase/.env.local`
Run: `BEARER=$(grep MCP_BEARER_TOKEN supabase/.env.local | cut -d= -f2); curl -s -X POST -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_events","arguments":{"limit":3}}}' http://127.0.0.1:54321/functions/v1/mcp | jq .`
Expected: a `result.content[0].text` JSON string with an `events` array.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/mcp/tools/events.ts supabase/functions/mcp/tools/events.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port events domain (5 tools)"
```

---

## Task 6 — Port `memories` domain

Same pattern as Task 5. Two tools (`transcribe_memory` is intentionally dropped — see spec Out of Scope).

**Source tools:** `add_event_memory` (line 1678), `list_event_memories` (line 1697). Find handlers in `mcp/src/index.ts` via `grep -n "function addEventMemory\|function listEventMemories" mcp/src/index.ts`.

**Files:**
- Create: `supabase/functions/mcp/tools/memories.ts`
- Create: `supabase/functions/mcp/tools/memories.test.ts`
- Modify: `supabase/functions/mcp/index.ts` (add memoriesModule to TOOLS)

- [ ] **Step 1: Write `tools/memories.test.ts` (same shape as `events.test.ts` from Task 5)**

```ts
import { describe, it, expect } from 'vitest'
import { memoriesModule } from './memories.ts'

describe('memories module', () => {
  it('registers exactly 2 tool definitions', () => {
    expect(memoriesModule.definitions).toHaveLength(2)
  })
  it('names', () => {
    const names = memoriesModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['add_event_memory', 'list_event_memories'])
  })
  it('does NOT include transcribe_memory (intentionally dropped in Phase A)', () => {
    expect(memoriesModule.definitions.find((d) => d.name === 'transcribe_memory')).toBeUndefined()
    expect(memoriesModule.dispatch.transcribe_memory).toBeUndefined()
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of memoriesModule.definitions) {
      expect(typeof memoriesModule.dispatch[def.name]).toBe('function')
    }
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails** — same as Task 5, Step 3.

- [ ] **Step 3: Port the two tools to `tools/memories.ts`** — apply Task 5 Step 4's pattern. Copy schemas from `mcp/src/index.ts:1678-1707`, port the `addEventMemory` and `listEventMemories` handler bodies, **do not port `transcribeMemory`**.

- [ ] **Step 4: Wire `memoriesModule` into `index.ts` TOOLS array.**

- [ ] **Step 5: Run tests and verify pass.**

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/memories.ts supabase/functions/mcp/tools/memories.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port memories domain (2 tools; transcribe_memory dropped)"
```

---

## Task 7 — Port `stories` domain

**Source tools:** `create_story` (1720), `update_story` (1741), `get_story` (1755), `list_stories` (1764), `delete_story` (1775). Handler functions: `createStory`, `updateStory`, `getStory`, `listStories`, `deleteStory`.

**Files:**
- Create: `supabase/functions/mcp/tools/stories.ts`
- Create: `supabase/functions/mcp/tools/stories.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `supabase/functions/mcp/tools/stories.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { storiesModule } from './stories.ts'

describe('stories module', () => {
  it('registers exactly 5 tool definitions', () => {
    expect(storiesModule.definitions).toHaveLength(5)
  })
  it('names', () => {
    const names = storiesModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_story', 'delete_story', 'get_story', 'list_stories', 'update_story'])
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of storiesModule.definitions) {
      expect(typeof storiesModule.dispatch[def.name]).toBe('function')
    }
  })
})
```

- [ ] **Step 2: Run test, confirm it fails** with `Cannot find module './stories.ts'`.
- [ ] **Step 3: Create `supabase/functions/mcp/tools/stories.ts`** — port schemas (lines 1720-1783 of `mcp/src/index.ts`) and handler bodies (`createStory`, `updateStory`, `getStory`, `listStories`, `deleteStory`) following the Task 5 Step 4 pattern: replace `pool.connect()` boilerplate with `ctx.client`, `await uid()` with `ctx.userId`.
- [ ] **Step 4: Wire `storiesModule` into `supabase/functions/mcp/index.ts` TOOLS array.**
- [ ] **Step 5: Run `npx vitest run mcp/tools/stories.test.ts` and verify all tests pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/stories.ts supabase/functions/mcp/tools/stories.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port stories domain (5 tools)"
```

---

## Task 8 — Port `photos` domain

**Source tools:** `create_photo_picker_session` (1784), `poll_photo_picker_session` (1789). Handlers: `createPhotoPickerSession`, `pollPhotoPickerSession`. These tools call Google Photos APIs — verify they only rely on env vars + DB state, not on Node-only modules. The `googleOAuth.ts` shared lib in `supabase/functions/_shared/` is already Deno-compatible; import from there.

**Files:**
- Create: `supabase/functions/mcp/tools/photos.ts`
- Create: `supabase/functions/mcp/tools/photos.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `supabase/functions/mcp/tools/photos.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { photosModule } from './photos.ts'

describe('photos module', () => {
  it('registers exactly 2 tool definitions', () => {
    expect(photosModule.definitions).toHaveLength(2)
  })
  it('names', () => {
    const names = photosModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_photo_picker_session', 'poll_photo_picker_session'])
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of photosModule.definitions) {
      expect(typeof photosModule.dispatch[def.name]).toBe('function')
    }
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/photos.ts`** — port schemas (1784-1800) and the two handlers. Import Google OAuth helpers from `../../_shared/googleOAuth.ts` (Deno-shape; the same import pattern used by other supabase/functions/ handlers).
- [ ] **Step 4: Wire `photosModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/photos.ts supabase/functions/mcp/tools/photos.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port photos domain (2 tools)"
```

---

## Task 9 — Port `gcal` domain

**Source tools:** `get_gcal_sync_candidates` (1801), `set_gcal_event_id` (1806). Handlers: `getGcalSyncCandidates`, `setGcalEventId`.

**Files:**
- Create: `supabase/functions/mcp/tools/gcal.ts`
- Create: `supabase/functions/mcp/tools/gcal.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/gcal.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { gcalModule } from './gcal.ts'

describe('gcal module', () => {
  it('registers 2 definitions', () => { expect(gcalModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(gcalModule.definitions.map((d) => d.name).sort()).toEqual(['get_gcal_sync_candidates', 'set_gcal_event_id'])
  })
  it('dispatch matches definitions', () => {
    for (const def of gcalModule.definitions) expect(typeof gcalModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/gcal.ts`** — port schemas (1801-1817) and both handler bodies.
- [ ] **Step 4: Wire `gcalModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/gcal.ts supabase/functions/mcp/tools/gcal.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port gcal domain (2 tools)"
```

---

## Task 10 — Port `relationships` domain

**Source tool:** `list_relationships` (1818). Handler: `listRelationships`.

**Files:**
- Create: `supabase/functions/mcp/tools/relationships.ts`
- Create: `supabase/functions/mcp/tools/relationships.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/relationships.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { relationshipsModule } from './relationships.ts'

describe('relationships module', () => {
  it('registers 1 definition', () => { expect(relationshipsModule.definitions).toHaveLength(1) })
  it('name', () => { expect(relationshipsModule.definitions[0].name).toBe('list_relationships') })
  it('dispatch exists', () => { expect(typeof relationshipsModule.dispatch.list_relationships).toBe('function') })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/relationships.ts`** — port schema (1818-1831) and `listRelationships` handler.
- [ ] **Step 4: Wire `relationshipsModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/relationships.ts supabase/functions/mcp/tools/relationships.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port relationships domain (1 tool)"
```

---

## Task 11 — Port `profile` domain

**Source tools:** `get_profile_context` (1832), `update_profile` (1843), `get_story_languages` (1857), `set_story_languages` (1862). Handlers: `getProfileContext`, `updateProfile`, `getStoryLanguages`, `setStoryLanguages`.

**Files:**
- Create: `supabase/functions/mcp/tools/profile.ts`
- Create: `supabase/functions/mcp/tools/profile.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/profile.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { profileModule } from './profile.ts'

describe('profile module', () => {
  it('registers 4 definitions', () => { expect(profileModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(profileModule.definitions.map((d) => d.name).sort()).toEqual([
      'get_profile_context', 'get_story_languages', 'set_story_languages', 'update_profile',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of profileModule.definitions) expect(typeof profileModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/profile.ts`** — port schemas (1832-1872) and the four handler bodies.
- [ ] **Step 4: Wire `profileModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/profile.ts supabase/functions/mcp/tools/profile.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port profile domain (4 tools)"
```

---

## Task 12 — Port `family` domain

**Source tools:** `add_family_member` (1873), `list_family_members` (1889). Handlers: `addFamilyMember`, `listFamilyMembers`.

**Files:**
- Create: `supabase/functions/mcp/tools/family.ts`
- Create: `supabase/functions/mcp/tools/family.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/family.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { familyModule } from './family.ts'

describe('family module', () => {
  it('registers 2 definitions', () => { expect(familyModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(familyModule.definitions.map((d) => d.name).sort()).toEqual(['add_family_member', 'list_family_members'])
  })
  it('dispatch matches definitions', () => {
    for (const def of familyModule.definitions) expect(typeof familyModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/family.ts`** — port schemas (1873-1893) and both handler bodies.
- [ ] **Step 4: Wire `familyModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/family.ts supabase/functions/mcp/tools/family.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port family domain (2 tools)"
```

---

## Task 13 — Port `locations` domain

**Source tools:** `add_location` (1894), `list_locations` (1909). Handlers: `addLocation`, `listLocations`.

**Files:**
- Create: `supabase/functions/mcp/tools/locations.ts`
- Create: `supabase/functions/mcp/tools/locations.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/locations.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { locationsModule } from './locations.ts'

describe('locations module', () => {
  it('registers 2 definitions', () => { expect(locationsModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(locationsModule.definitions.map((d) => d.name).sort()).toEqual(['add_location', 'list_locations'])
  })
  it('dispatch matches definitions', () => {
    for (const def of locationsModule.definitions) expect(typeof locationsModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/locations.ts`** — port schemas (1894-1913) and both handler bodies.
- [ ] **Step 4: Wire `locationsModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/locations.ts supabase/functions/mcp/tools/locations.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port locations domain (2 tools)"
```

---

## Task 14 — Port `watches` domain

**Source tools:** `get_event_watch_task` (1914), `get_watch_queue` (1925), `update_watch_task` (1930), `create_watch_task` (1950). Handlers: `getEventWatchTask`, `getWatchQueue`, `updateWatchTask`, `createWatchTask`.

**Files:**
- Create: `supabase/functions/mcp/tools/watches.ts`
- Create: `supabase/functions/mcp/tools/watches.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/watches.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { watchesModule } from './watches.ts'

describe('watches module', () => {
  it('registers 4 definitions', () => { expect(watchesModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(watchesModule.definitions.map((d) => d.name).sort()).toEqual([
      'create_watch_task', 'get_event_watch_task', 'get_watch_queue', 'update_watch_task',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of watchesModule.definitions) expect(typeof watchesModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Create `tools/watches.ts`** — port schemas (1914-1962) and the four handler bodies.
- [ ] **Step 4: Wire `watchesModule` into TOOLS.**
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/watches.ts supabase/functions/mcp/tools/watches.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port watches domain (4 tools)"
```

---

## Task 15 — Port `sources` domain

**Source tools:** `save_source` (1963), `update_source` (1977), `get_unanalysed_sources` (1991), `search_sources` (1996). Handlers: `saveSource`, `updateSource`, `getUnanalysedSources`, `searchSources`.

The `sources.ts` Node module (`mcp/src/sources.ts`, 45 LOC) contains pure helpers (`parseSourceUrl`, `normaliseTags`, `validateName`, `validateSourceType`). Duplicate as `supabase/functions/mcp/tools/sourcesHelpers.ts` to keep the Deno tree self-contained (cross-tier shared module is overkill at this size).

**Files:**
- Create: `supabase/functions/mcp/tools/sources.ts`
- Create: `supabase/functions/mcp/tools/sourcesHelpers.ts`
- Create: `supabase/functions/mcp/tools/sources.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/sources.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { sourcesModule } from './sources.ts'

describe('sources module', () => {
  it('registers 4 definitions', () => { expect(sourcesModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(sourcesModule.definitions.map((d) => d.name).sort()).toEqual([
      'get_unanalysed_sources', 'save_source', 'search_sources', 'update_source',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of sourcesModule.definitions) expect(typeof sourcesModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Duplicate helpers** — copy `mcp/src/sources.ts` content verbatim into `supabase/functions/mcp/tools/sourcesHelpers.ts`. The helpers are dependency-free TypeScript; they work unchanged in Deno.
- [ ] **Step 4: Create `tools/sources.ts`** — port schemas (1963-2006) and the four handlers; import helpers from `./sourcesHelpers.ts`.
- [ ] **Step 5: Wire `sourcesModule` into TOOLS; run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/sources.ts supabase/functions/mcp/tools/sourcesHelpers.ts supabase/functions/mcp/tools/sources.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port sources domain (4 tools)"
```

---

## Task 16 — Port `profileFacts` domain

**Source tools:** `list_profile_facts` (2007), `get_historical_facts` (2017), `correct_profile_fact` (2027), `upsert_profile_fact` (2041). Handlers: `listProfileFacts`, `getHistoricalFacts`, `correctProfileFact`, `upsertProfileFact`.

The `profileFacts.ts` Node module has confidence-scoring helpers (`initialConfidence`, `computeCorroborationConfidence`, `computeContradictionConfidence`, `shouldMarkHistorical`) — duplicate as `tools/profileFactsHelpers.ts`, same approach as Task 15.

**Files:**
- Create: `supabase/functions/mcp/tools/profileFacts.ts`
- Create: `supabase/functions/mcp/tools/profileFactsHelpers.ts`
- Create: `supabase/functions/mcp/tools/profileFacts.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Write `tools/profileFacts.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { profileFactsModule } from './profileFacts.ts'

describe('profileFacts module', () => {
  it('registers 4 definitions', () => { expect(profileFactsModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(profileFactsModule.definitions.map((d) => d.name).sort()).toEqual([
      'correct_profile_fact', 'get_historical_facts', 'list_profile_facts', 'upsert_profile_fact',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of profileFactsModule.definitions) expect(typeof profileFactsModule.dispatch[def.name]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test, confirm fail.**
- [ ] **Step 3: Duplicate helpers** — copy `mcp/src/profileFacts.ts` content verbatim into `supabase/functions/mcp/tools/profileFactsHelpers.ts`.
- [ ] **Step 4: Create `tools/profileFacts.ts`** — port schemas (2007-2060) and the four handlers; import helpers from `./profileFactsHelpers.ts`.
- [ ] **Step 5: Wire `profileFactsModule` into TOOLS; run tests, verify pass.**
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp/tools/profileFacts.ts supabase/functions/mcp/tools/profileFactsHelpers.ts supabase/functions/mcp/tools/profileFacts.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): port profileFacts domain (4 tools)"
```

---

## Task 17 — Smoke test (`tests/smoke/tier1-http-mcp.sh`)

**Files:**
- Create: `tests/smoke/tier1-http-mcp.sh`

- [ ] **Step 1: Write the smoke test**

```bash
#!/usr/bin/env bash
# End-to-end smoke for Tier 1 HTTP MCP. Run from repo root with local Supabase
# already up. Exits non-zero on any check failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Reset to a known mode and back so the toggle is exercised.
bash scripts/mcp-mode.sh http >/dev/null
TOKEN=$(grep '^MCP_BEARER_TOKEN=' supabase/.env.local | head -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "FAIL: no bearer in supabase/.env.local"; exit 1; }

# Start `supabase functions serve mcp` in the background.
supabase functions serve mcp --env-file supabase/.env.local > /tmp/mcp-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT

# Wait up to 15s for the server to come up.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/functions/v1/mcp | grep -q '401'; then
    break
  fi
  sleep 0.5
done

# Validate auth rejection (no bearer → 401).
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/functions/v1/mcp)
[ "$CODE" = "401" ] || { echo "FAIL: expected 401 without bearer, got $CODE"; exit 1; }

# Validate tools/list returns the expected tool count.
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:54321/functions/v1/mcp)
COUNT=$(echo "$RESP" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')
[ "$COUNT" -ge 37 ] || { echo "FAIL: expected >=37 tools, got $COUNT"; echo "$RESP" | head; exit 1; }

# Validate transcribe_memory is absent (Phase A drop).
echo "$RESP" | grep -q '"transcribe_memory"' && { echo "FAIL: transcribe_memory should be dropped in Phase A"; exit 1; }

echo "OK ($COUNT tools registered)"
```

```bash
chmod +x tests/smoke/tier1-http-mcp.sh
```

- [ ] **Step 2: Run the smoke test (requires `local-start.sh` running)**

Run: `bash tests/smoke/tier1-http-mcp.sh`
Expected: `OK (37 tools registered)` or higher count.

- [ ] **Step 3: Commit**

```bash
git add tests/smoke/tier1-http-mcp.sh
git commit -m "test(mcp): tier-1 HTTP MCP smoke test"
```

---

## Task 18 — `plannen-doctor` mode detection

**Files:**
- Modify: `plugin/commands/plannen-doctor.md`

- [ ] **Step 1: Read the current doctor command**

Open `plugin/commands/plannen-doctor.md`. Find the section that lists check items.

- [ ] **Step 2: Add an MCP mode detection check**

Add (or update) a check item:

````markdown
### MCP mode

Read `plugin/.claude-plugin/plugin.json`. The `mcpServers.plannen` entry is one of:

- `{ "command": "node", ... }` → **stdio MCP** (Node-based, Tier 0 / Tier 1 default).
- `{ "type": "http", ... }` → **HTTP MCP** (Edge-Function-based, Tier 1 opt-in).

If `type === "http"`, also verify:
- `supabase/.env.local` exists and contains `MCP_BEARER_TOKEN=`.
- The `url` resolves: `curl -s -o /dev/null -w '%{http_code}' "$URL"` returns `401` (server up, no bearer in this probe) or `200` (with bearer).

Print the resolved mode plus any verification failures.
````

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/plannen-doctor.md
git commit -m "docs(mcp): plannen-doctor detects stdio vs http MCP mode"
```

---

## Task 19 — README + CONTRIBUTING update

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Open `README.md` and find the section describing the MCP server**

It is likely under "Architecture" or "How it works." Add (or replace) the MCP paragraph with:

```markdown
### MCP server modes

Plannen ships two MCP server implementations:

- **stdio (default)** — `mcp/src/` Node process, spawned by Claude Code as a subprocess. Used in Tier 0 and Tier 1 by default.
- **HTTP (opt-in on Tier 1)** — `supabase/functions/mcp/` Deno Edge Function, served by `supabase functions serve mcp` and reached over HTTPS with a bearer token. Used for dev / for Tier 2 once the cloud deploy spec lands.

Switch between them with `bash scripts/mcp-mode.sh stdio` or `bash scripts/mcp-mode.sh http`. The HTTP mode generates and persists a bearer in `supabase/.env.local` on first use. After switching, reload the plannen plugin in Claude Code.

The HTTP MCP does not include `transcribe_memory` (it requires a local Whisper binary not available in Deno). Use stdio if you need audio transcription.
```

- [ ] **Step 2: Open `CONTRIBUTING.md` and add a developer-flow paragraph**

In the developer-flow section, add:

```markdown
### Developing the HTTP MCP

```
$ bash scripts/local-start.sh                 # local Supabase up
$ bash scripts/mcp-mode.sh http               # switch plugin to HTTP MCP
$ supabase functions serve mcp \
    --env-file supabase/.env.local            # serve the function (foreground)
```

Reload the plannen plugin in Claude Code. Tool changes in `supabase/functions/mcp/` are picked up automatically by `supabase functions serve`. Switch back with `bash scripts/mcp-mode.sh stdio` when done.

End-to-end smoke: `bash tests/smoke/tier1-http-mcp.sh` (requires `local-start.sh` running).
```

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs(mcp): README and CONTRIBUTING cover the HTTP MCP mode"
```

---

## Task 20 — CI integration

**Files:**
- Modify: `.github/workflows/*.yml` (the existing test workflow — locate via `ls .github/workflows/`)

- [ ] **Step 1: Locate the existing workflow file**

Run: `ls .github/workflows/`
Open the file that runs `supabase/functions` vitest (likely `test.yml`, `ci.yml`, or similar — grep for `supabase/functions`).

- [ ] **Step 2: Update the include pattern check**

The existing job that runs `cd supabase/functions && npx vitest run` already picks up the new tests because `vitest.config.ts` was updated in Task 1. Verify the workflow does not pin a narrower include path on the command line. If it does, update it to drop the narrower path.

- [ ] **Step 3: Run the workflow locally (if `act` is available) or push and watch**

Run (if applicable): `act -j <job-name>` to dry-run, or push the branch and watch GitHub Actions.
Expected: the test job picks up `supabase/functions/mcp/**/*.test.ts` and runs them alongside the existing `_shared/handlers` tests.

- [ ] **Step 4: Commit any workflow changes**

```bash
git add .github/workflows/<file>.yml
git commit -m "ci(mcp): include supabase/functions/mcp/ in the existing vitest job"
```

(If no workflow change was needed, skip this step. The vitest.config.ts edit from Task 1 already does the work.)

---

## Self-Review

**Spec coverage:**
- Architecture (spec § Architecture) → Tasks 1, 2, 3.
- Components (spec § Components) → Tasks 1-19 (every row in the spec's component table maps to a task).
- Data flow (spec § Data flow) → Tasks 3, 4, 17 (transport hookup, mode toggle, smoke).
- Schema changes — none in Phase A. No migration tasks. ✓
- Error handling (spec § Error handling) → Task 2 (auth 401), Task 3 (DB error path through `withDb`'s try/catch, tool dispatch error envelope).
- Testing (spec § Testing) → Task 5 (unit pattern), Tasks 6-16 (per-domain unit tests), Task 17 (smoke), Task 20 (CI).
- Out of scope (spec § Out of scope) → not built, captured in Task 6 (`transcribe_memory` dropped + test that asserts its absence).
- Future work (spec § Future work) → not built. Plan references the spec's pointer; no follow-up plan tasks here.

**Placeholder scan:** No `TBD` / `TODO` / `fill in` in the plan body. The `'PORT INCOMPLETE'` strings inside Task 5 Step 4 are intentional scaffolding placeholders that the engineer replaces during the task itself; they are documented in-line as "remove after porting."

**Type consistency:** `ToolCtx`, `ToolHandler`, `ToolDefinition`, `ToolModule` defined in Task 1 (`types.ts`) and used consistently in Tasks 3, 5-16. The handler signature `(args: unknown, ctx: ToolCtx) => Promise<unknown>` is the same across all port tasks.

**Risks called out in the spec** (`StreamableHTTPServerTransport` Deno compat, pg pool sizing, bearer in plugin.json, plugin reload friction) — Task 3 prototypes the transport on day 1; pool sizing is left at defaults with a note to revisit; bearer is in a non-checked-in `plugin.json` (see Task 4's idempotency); reload is a documented user step (Tasks 18, 19).
