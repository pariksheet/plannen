# Tier-0 `claude -p` AI provider

**Date:** 2026-05-15
**Type:** Backend architecture (Tier 0 only)
**Status:** Design approved

## Problem

Plannen's Tier-0 backend AI calls (`_shared/ai.ts` → `generate` / `generateStructured` / `generateFromImage`) today require a BYOK Anthropic console API key, configured in `/settings`. Users who already pay for a Claude subscription via Claude Code must either pay twice (subscription + console credits) or live without server-side AI features.

The MCP path inside Claude Code already runs on the user's subscription — this design adds the inverse: a Plannen-driven `claude -p` subprocess call that uses the user's locally installed Claude Code authentication, with no console API key.

## Decision

Add a new provider value `claude-code-cli` to `plannen.user_settings.provider`. In Tier 0, when this is the active provider, `_shared/ai.ts` dispatches to a Node-only `ClaudeCliProvider` that shells out to `claude -p --output-format=json` and parses the wrapper JSON.

**Tier scoping:** Tier 0 only. Tier 1 edge functions run in Deno and cannot shell out to host binaries; the Node-only provider files are physically absent from the Deno tree, so the `claude-code-cli` provider value is unreachable there.

**Onboarding:** Backend boot probe detects `claude --version`. If present and the user has no `user_settings` row yet, auto-configure the CLI provider as default. If a row exists, never override. Fall back to existing BYOK flow if `claude` is absent.

## Compliance

Verified 2026-05-14 against Anthropic's Legal & Compliance documentation at https://code.claude.com/docs/en/legal-and-compliance.

**Sanctioned.** Anthropic's policy page states verbatim: *"Starting June 15, 2026, Agent SDK and `claude -p` usage on subscription plans will draw from a new monthly Agent SDK credit, separate from your interactive usage limits."* This is explicit confirmation that scripted `claude -p` invocation from a third-party caller is permitted — metered, not banned.

**Prohibited (and avoided here).** `CLAUDE_CODE_OAUTH_TOKEN` (obtained via `claude setup-token`) used in any third-party tool, including the Agent SDK, is prohibited as of 2026-02-19. Sources: https://code.claude.com/docs/en/authentication and https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/. Plannen does not touch, route, or persist subscription tokens — the `claude` binary runs as the user's own subprocess on the user's own machine, authenticating against the user's own Claude Code installation. Plannen captures stdout/stderr only.

**Precedent.** Anthropic's own `claude-code-action` GitHub Action shells out to `claude` from a third-party orchestrator. The Plannen CLI provider is structurally identical.

## Architecture

```
backend/src/_shared/
  ai.ts                         # MODIFIED: dispatches via AIProvider interface
  providers/
    types.ts                    # NEW: AIProvider interface, shared types
    anthropic.ts                # NEW: existing Anthropic code extracted here
    claude-cli.ts               # NEW: subprocess shim (Tier-0 only, Node-only)
    run-cli.ts                  # NEW: child_process wrapper + timeout/kill
  cliDetection.ts               # NEW: cached `claude --version` probe
  handlers/                     # UNCHANGED — still imports from ../ai.js

supabase/functions/_shared/
  ai.ts                         # MODIFIED: dispatches via AIProvider (Anthropic only)
  providers/
    types.ts                    # NEW: structurally identical to Node copy (import specifiers diverge)
    anthropic.ts                # NEW: structurally identical to Node copy (import specifiers diverge)
    # No claude-cli.ts or run-cli.ts in this tree — Node-only by design

backend/src/index.ts            # MODIFIED: invoke CLI boot probe + auto-config
backend/src/routes/api/settings.ts  # MODIFIED: tier endpoint + CLI validation
web/src/routes/settings/...     # MODIFIED: UI for CLI provider option
# scripts/bootstrap.sh — already writes PLANNEN_TIER to .env (line 251); no change needed
```

**Tier-1 invariant.** The Deno tree never imports `claude-cli.ts` or `run-cli.ts`. The provider value `claude-code-cli` is unreachable at runtime in Tier 1 (onboarding never writes it; defensive `no_provider_configured` throw in the Deno dispatcher if it somehow appears).

**Tree synchronisation.** The Node tree (`backend/src/_shared/`) and the Deno tree (`supabase/functions/_shared/`) are hand-synced today — the two existing `ai.ts` files are byte-different but same line count, divergent only in import specifiers (`npm:ai@4` ↔ `ai`, `.ts` ↔ `.js`). This spec preserves that convention: `providers/types.ts` and `providers/anthropic.ts` are created in both trees with identical structure, divergent only on import specifiers. `providers/claude-cli.ts` and `providers/run-cli.ts` exist **only** in the Node tree, by design — they have no Deno counterpart. A future refactor to automate the sync is out of scope for this spec.

**Tier signal.** `bootstrap.sh` writes `PLANNEN_TIER=0` or `PLANNEN_TIER=1` to `.env`. Backend reads `process.env.PLANNEN_TIER` at boot. The CLI boot probe runs only when tier is 0.

## Module contracts

### `AIProvider` interface (`providers/types.ts`)

```ts
export interface AIProvider {
  generate(ctx: HandlerCtx, opts: GenerateOpts): Promise<string>
  generateStructured<T>(ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T>
  generateFromImage(ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string>
}

export type GenerateOpts = {
  prompt: string
  model?: string
  tools?: ReadonlyArray<'web_search'>
  maxTokens?: number
}
export type GenerateStructuredOpts<T> = GenerateOpts & { schema: z.ZodSchema<T> }
export type GenerateFromImageOpts = {
  imageBytes: Uint8Array
  mimeType: string
  prompt: string
  model?: string
  maxTokens?: number
}
```

`withRetryAndTracking` (rate-limit retry + `last_used_at` recording) stays in `ai.ts` and wraps every provider call. Providers throw `AIError`; the dispatcher records usage and rethrows. `normaliseError` also stays in `ai.ts` — providers can return raw errors when an SDK-style status code is meaningful, but the CLI provider throws pre-normalised `AIError` instances because its failure modes have no HTTP status to fall back to.

### `Provider` type

```ts
export type Provider = 'anthropic' | 'claude-code-cli'   // was 'anthropic' only
```

Widened in both Deno and Node copies. The runtime impossibility of CLI in Tier 1 is enforced at the dispatcher, not at the type level.

### `ai.ts` dispatcher

```ts
function providerFor(s: AISettings): AIProvider {
  switch (s.provider) {
    case 'anthropic':       return anthropicProvider(s)
    case 'claude-code-cli': return claudeCliProvider(s)   // Node tree only
    default: { const _e: never = s.provider; throw new AIError('no_provider_configured', ...) }
  }
}

export async function generate(ctx, opts) {
  const s = await getUserAI(ctx)
  return withRetryAndTracking(ctx, s, () => providerFor(s).generate(ctx, opts))
}
// generateStructured and generateFromImage follow the same shape.
```

In the Deno copy, the `claude-code-cli` case throws `no_provider_configured` and the import line for `claudeCliProvider` is absent (the file does not exist in the Deno tree — see *Tree synchronisation* above). Exhaustiveness check still passes because the union is widened.

### `getUserAI` — accept CLI rows with NULL `api_key`

Today `ai.ts` rejects rows with empty `api_key`. That rule becomes provider-aware:

```ts
const row = rows[0]
if (!row) throw new AIProviderNotConfigured()
if (row.provider === 'anthropic' && !row.api_key) throw new AIProviderNotConfigured()
// CLI rows have api_key = NULL by design — that's not "not configured".
```

The Deno copy gets the same change so the type stays in lockstep. CLI rows never exist in Tier 1 in practice.

### `runCli` (`providers/run-cli.ts`)

```ts
export type RunCliResult = { stdout: string; stderr: string; exitCode: number }
export type RunCli = (cmd: string, args: string[], opts: RunCliOpts) => Promise<RunCliResult>
export type RunCliOpts = {
  timeoutMs: number    // default 90_000
  input?: string       // optional stdin
}
```

Behaviour:
- ENOENT on spawn → throws error tagged `code: 'ENOENT'`.
- Timeout exceeded → SIGTERM, then SIGKILL after 5s grace; throws error tagged `code: 'ETIMEDOUT'`.
- Exit code returned as-is in the result object; non-zero is not an exception.
- stdout/stderr collected as UTF-8 strings.

### `claudeCliProvider` factory

```ts
export function makeClaudeCliProvider(deps: {
  runCli: RunCli
  tmpDir?: () => string                 // defaults to os.tmpdir()
  uuid?: () => string                   // defaults to crypto.randomUUID()
  binary?: string                       // defaults to 'claude'
}): (s: AISettings) => AIProvider
```

Production: one call to `makeClaudeCliProvider({ runCli: defaultRunCli })` at module load. Tests: pass mocked `runCli` returning canned output.

## Subprocess invocation

### `generate` flow

```ts
const args = ['-p', '--output-format=json']
if (opts.tools?.includes('web_search')) args.push('--allowed-tools', 'WebSearch')
args.push(opts.prompt)

const { stdout, stderr, exitCode } = await runCli('claude', args, { timeoutMs: 90_000 })
return unwrapClaudeJson(stdout, stderr, exitCode).result
```

### `generateStructured` flow

Identical to `generate` except:
- Append `\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.` to the prompt.
- Feed `.result` through the existing `parseJsonAgainstSchema(text, schema)` helper from `ai.ts` (reused unchanged).

This mirrors the existing tools-enabled branch in `ai.ts:258-269`. Callers continue to describe field shape in their own prompt prose; the schema validates after.

### `generateFromImage` flow

```ts
const ext = extForMimeType(opts.mimeType)
const path = join(tmpDir(), `plannen-img-${uuid()}.${ext}`)
await fs.writeFile(path, opts.imageBytes)
try {
  const promptWithImage = `Analyze the image at ${path}:\n\n${opts.prompt}`
  const args = ['-p', '--output-format=json', '--allowed-tools', 'Read', promptWithImage]
  const { stdout, stderr, exitCode } = await runCli('claude', args, { timeoutMs: 90_000 })
  return unwrapClaudeJson(stdout, stderr, exitCode).result
} finally {
  await fs.unlink(path).catch(() => {})
}
```

`extForMimeType` handles `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Unknown types throw `AIError('unknown_error', 'Unsupported image type for CLI provider')`. Reference syntax is a natural-language path inside the prompt; the `--allowed-tools Read` flag lets Claude open it. We deliberately do not depend on TUI `@/path` mention syntax (undocumented behaviour in headless).

### `unwrapClaudeJson`

```ts
function unwrapClaudeJson(stdout: string, stderr: string, exitCode: number): { result: string } {
  if (exitCode !== 0) {
    throw new AIError('provider_unavailable', `claude exited ${exitCode}: ${truncate(stderr, 500)}`)
  }
  let wrapper: any
  try { wrapper = JSON.parse(stdout) }
  catch { throw new AIError('unknown_error', `claude output unparseable: ${truncate(stdout, 200)}`) }

  if (wrapper.is_error === true || wrapper.subtype === 'error') throw mapClaudeError(wrapper)
  if (typeof wrapper.result !== 'string') {
    throw new AIError('unknown_error', 'claude wrapper missing .result string — format may have changed')
  }
  return { result: wrapper.result }
}
```

### `mapClaudeError` (wrapper error → `AIError`)

Loose message-text matching:
- Mentions `"log in" | "authenticate" | "not authenticated"` → `invalid_api_key`, message `"Run \`claude\` in your terminal to log in."`
- Mentions `"rate" | "limit" | "quota" | "credit"` → `rate_limited`, `retryAfterSeconds` from wrapper if present else 60.
- Anything else → `provider_unavailable` with the wrapper message.

Brittleness is accepted here. Tests pin known messages; if Claude Code changes them, CI fails and we adapt.

### `runCli` error mapping

```ts
try {
  result = await runCli('claude', args, { timeoutMs })
} catch (e) {
  if (e.code === 'ENOENT') {
    throw new AIError('no_provider_configured',
      'Claude CLI not found in PATH — install Claude Code or switch to BYOK in /settings.')
  }
  if (e.code === 'ETIMEDOUT') {
    throw new AIError('provider_unavailable', `claude subprocess timed out after ${timeoutMs}ms.`)
  }
  throw new AIError('unknown_error', `claude subprocess failed: ${e.message}`)
}
```

## Onboarding

### `bootstrap.sh` (already done — verify, don't modify)

The existing `bootstrap.sh:251` already writes `PLANNEN_TIER=<n>` into `.env` (`env_set "$ENV_FILE" PLANNEN_TIER "$TIER"`). No bootstrap changes required for this design.

### Boot probe (`backend/src/_shared/cliDetection.ts`)

```ts
type CliDetection = { available: boolean; version: string | null }
let cached: CliDetection | null = null

export async function detectClaudeCli(runCli: RunCli): Promise<CliDetection> {
  if (cached) return cached
  try {
    const { stdout, exitCode } = await runCli('claude', ['--version'], { timeoutMs: 5_000 })
    cached = { available: exitCode === 0, version: parseVersion(stdout) }
  } catch {
    cached = { available: false, version: null }
  }
  return cached
}
```

`parseVersion` is tolerant: scans `stdout` for the first match of `/(\d+)\.(\d+)\.(\d+)/` and returns the captured string, or `null` if no match. Version display is informational only — the boot probe's `available: true` decision rests on the exit code, not on successful version parsing.

At boot in `backend/src/index.ts`, after DB and user resolution:

```ts
if (process.env.PLANNEN_TIER === '0') {
  const detection = await detectClaudeCli(defaultRunCli)
  if (detection.available) await maybeAutoConfigureCliProvider(db, userId, detection.version)
}
```

### Auto-config rule

```ts
async function maybeAutoConfigureCliProvider(db, userId, version) {
  const existing = await db.query(
    'SELECT id FROM plannen.user_settings WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId],
  )
  if (existing.rows.length > 0) return   // never override user's existing default

  await db.query(
    `INSERT INTO plannen.user_settings (user_id, provider, is_default, default_model, api_key, base_url)
     VALUES ($1, 'claude-code-cli', true, NULL, NULL, NULL)`,
    [userId],
  )
  log.info(`Detected Claude CLI ${version} — using your subscription for AI calls.`)
}
```

Re-boots are no-ops once a row exists.

## Settings API & UI

### New endpoint

`GET /api/settings/system` returns:

```json
{ "tier": 0, "cliAvailable": true, "cliVersion": "1.2.3" }
```

`cliAvailable` reflects the cached boot probe. `cliVersion` is `null` if probe failed.

### `PATCH /api/settings` validation

Body accepts `{ provider, api_key?, base_url?, default_model?, is_default? }` (unchanged shape from today). New rules:

- `provider: 'claude-code-cli'` → `api_key` must be null/absent; tier must be 0 and `cliAvailable` must be true. Otherwise 400 with explanatory message.
- `provider: 'anthropic'` → `api_key` required (unchanged behaviour).

### Web `/settings` UI

```
On page load:
  fetch /api/settings/system      → { tier, cliAvailable, cliVersion }
  fetch /api/settings             → current user_settings row

Provider dropdown options:
  - "Anthropic (BYOK)"
  - "Claude Code CLI (your subscription)"
       ← shown only when tier===0 && cliAvailable
       ← subtitle: "Claude Code <version> detected"

When CLI is selected:
  - hide API key input
  - hide model dropdown (v1: no model selection for CLI)
  - show banner: "Plannen will use your installed Claude CLI for AI calls.
                  Anthropic bills your subscription, not a separate API key."
  - "Test AI" button works as today (POSTs to /functions/v1/agent-test).

When CLI not detected on tier 0:
  - dropdown shows only "Anthropic (BYOK)"
  - subtext: "To use your Claude subscription instead, install Claude Code."

When tier === 1:
  - dropdown shows only "Anthropic (BYOK)" — CLI option hidden entirely.
```

## Testing

**New unit tests:**
- `backend/src/_shared/providers/claude-cli.test.ts` — mocked `runCli`, covering nine cases:
  1. Happy-path `generate` — valid wrapper, `.result` returned.
  2. Happy-path `generateStructured` — wrapper `.result` parses to typed object via `parseJsonAgainstSchema`.
  3. Image flow — temp file written, `runCli` called with `--allowed-tools Read` and path embedded in prompt, temp file unlinked on success and on error.
  4. `web_search` routing — `tools: ['web_search']` produces `--allowed-tools WebSearch` in args.
  5. ENOENT → `AIError('no_provider_configured', ...)` with CLI-specific message.
  6. Non-zero exit → `provider_unavailable` with stderr in message.
  7. Timeout → `provider_unavailable`.
  8. `is_error` in wrapper — auth message → `invalid_api_key`; credit/quota message → `rate_limited`.
  9. Unparseable `.result` JSON → `unknown_error`.
- `backend/src/_shared/cliDetection.test.ts` — ENOENT path, success path, version-parse failure.
- `backend/src/routes/api/settings.test.ts` — extend for `/api/settings/system` and CLI-provider validation in `PUT /api/settings`.

**Refactored tests:** existing Anthropic provider behaviour moves verbatim from `ai.test.ts` to `providers/anthropic.test.ts`. No behaviour change.

**Unchanged tests:** all handler tests in `_shared/handlers/*.test.ts` continue to use `_testlib/ai.ts` mocks. The provider switch is transparent to them.

**No real-binary CI tests.** A manual smoke script `scripts/smoke-cli-provider.sh` lives in the repo for local verification (runs `claude --version`, fires a one-shot `generate`, checks response shape). Out of CI; documented in CONTRIBUTING.md.

## Contract surface (what we depend on from `claude -p`)

1. `claude --version` exits 0 with parseable version output when installed.
2. `claude -p --output-format=json <prompt>` writes JSON to stdout with at minimum:
   - `.result: string` (model output)
   - `.is_error: boolean` OR `.subtype === 'error'` (error signal)
3. `--allowed-tools <comma-separated>` accepts `Read` and `WebSearch`.
4. The `Read` tool reads images at absolute file paths.
5. Errors on stderr; hard failures exit non-zero.

**Not depended on:** `.session_id`, `.total_cost_usd`, streaming output, model-selection flags, specific stderr format.

**Pinned version range:** README states "tested with Claude Code 1.x". On a major-version mismatch, boot probe logs a warning but proceeds. Tests fail noisily when shape changes — that's the signal to adapt.

## Degradation

- **Boot probe fails** → skip auto-config silently; existing BYOK flow stays. Debug log line records the failure.
- **Wrapper JSON unparseable** → log truncated stdout, throw `unknown_error` with "Claude Code output unexpected — please report if this persists." User has BYOK escape hatch in `/settings`.
- **`.result` missing** → same as above.
- **Future flag-name change** → CI tests fail on the version bump; bug visible, fixable by adapting `runCli` args.

## Non-goals (explicit v1 scope guard)

- No DB schema change. `provider` is already a string column; no new constraints needed.
- No multi-provider extensibility (Ollama, Gemini, OpenAI-compatible). Future work.
- No model-selection UI for CLI provider.
- No per-call provider override. Provider-level opt-in only.
- No Tier-1 support for CLI provider. Physical file separation enforces.
- No real-binary tests in CI.
- No `/api/settings/system/recheck-cli` endpoint. Backend boot performs the only probe in v1.

## Hard constraints (checklist)

The implementation plan must respect:

- ✅ No DB schema change.
- ✅ Tier 1 Deno edge functions continue to compile unchanged (Node-only files absent from Deno tree; Deno dispatcher defensively throws on `claude-code-cli`).
- ✅ Forward-only migrations (none needed).
- ✅ AI keys never read from request bodies (this provider has no key).
- ✅ Three-process Tier-0 workflow unchanged.
- ✅ No new long-running processes.

## Success criteria

- Tier-0 user with `claude` installed: on first boot, backend auto-configures CLI provider; `/settings` reflects this; AI features (Discovery, source analysis, story-writing, image extraction) work without an Anthropic API key.
- Tier-0 user without `claude` installed: existing BYOK flow works exactly as before, no regression.
- Tier-0 user with existing BYOK config + later installs `claude`: existing default is not overridden; CLI option appears in `/settings` dropdown; user can switch manually.
- Tier-1 user: no CLI option visible; BYOK works exactly as today; `claude-code-cli` provider value cannot be saved.
- Test suite: all existing tests pass unchanged; new claude-cli tests cover the nine cases above; smoke script verifies locally against a real `claude` binary.
