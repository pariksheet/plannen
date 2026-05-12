# Plannen BYOK (Bring Your Own Key) — Design

**Date:** 2026-05-09
**Status:** Design approved; pending spec review and implementation plan
**Branch:** feat/tier-1-opensource
**Related:** `2026-05-09-plannen-plugin-architecture-design.md`

## Context

Plannen's tiered deployment model (`docs/TIERED_DEPLOYMENT_MODEL.md`) commits to BYOK AI in Tiers 1–3 — users bring their own provider key; the platform never pays for LLM calls in those tiers. This spec defines the V1 BYOK implementation.

### Current state

- Three Supabase Edge Functions call an LLM today: `agent-discover`, `agent-extract-image`, `agent-scrape`.
- All three use **Gemini** via `supabase/functions/_shared/gemini.ts`, reading `GEMINI_API_KEY` from `Deno.env.get`.
- A partial **Anthropic** path exists alongside Gemini in `supabase/functions/_shared/claude.ts` (direct `fetch` to `/v1/messages`, `web_search_20250305` tool for discovery). The web app already has a localStorage-backed Anthropic key UI (`src/components/Settings.tsx` + `src/context/SettingsContext.tsx`); both `agent-discover` and `agent-scrape` accept an `anthropic_api_key` field in the request body.
- `agent-discover` also uses `SERPER_API_KEY` for Google Search; falls back to Gemini if Serper is absent.
- No AI SDKs are in `package.json`. No provider abstraction. No settings UI for keys backed by the DB. No per-request server-side key resolution.
- The MCP server **does not call LLMs** — it only wraps Supabase tools. AI calls happen in edge functions only.
- BYOK in `TIERED_DEPLOYMENT_MODEL.md` is aspirational: only the partial Anthropic path described above is wired up.

The MCP itself doesn't need a key. BYOK is a web-app + edge-function concern.

### Existing implementation being replaced

V1 BYOK rips out the partial Anthropic implementation and replaces it cleanly. No transitional dual-support, no commented-out paths.

| Existing | Replaced by |
|---|---|
| `src/components/Settings.tsx` (localStorage, single-Anthropic, password input + Clear) | New DB-backed Settings UI with multi-provider schema, masked input, Test button, status line. |
| `src/context/SettingsContext.tsx` (localStorage write/read for `plannen_settings`) | Supabase-client-backed reader of `user_settings`. |
| `supabase/functions/_shared/claude.ts` (direct-fetch Anthropic with `web_search_20250305` tool) | AI SDK wrapper at `supabase/functions/_shared/ai.ts`. |
| `supabase/functions/_shared/gemini.ts` (direct-fetch Gemini, ListModels fallback) | Deleted. Re-introduce via the wrapper switch in V1.1. |
| Per-request `anthropic_api_key` in request body | Server-side `auth.uid()` lookup against `user_settings` inside `_shared/ai.ts`. |
| `SERPER_API_KEY` Google Search fallback in `agent-discover` | Anthropic's built-in `web_search` tool via the AI SDK `tools` field. |
| Default Anthropic model `claude-opus-4-7` (in `_shared/claude.ts`) | Default `claude-sonnet-4-6` per the V1 BYOK design (cheaper; sufficient for these workflows). |
| Unstructured `throw new Error(...)` from `claude.ts` | Typed error codes per the Failure modes table. |

## Goals & non-goals

### Goals

- An OSS user can configure an API key in the web app and use Plannen's AI features (discovery, image extraction, scrape fallback) without anyone else paying for the calls.
- The architecture is provider-agnostic from day one — adding new providers in V1.1 (Gemini, OpenAI, Ollama, etc.) requires no schema migrations or breaking changes, only UI cards and one wrapper case per provider.
- The wrapper layer is the single point that knows which provider is configured. Edge functions call generic `generate` / `generateStructured` / `generateFromImage` and never import an SDK directly.
- V1 is forward-compatible with Tier 4 (hosted, platform-paid AI) without code paths that would conflict.
- V1 deliberately moves the BYOK boundary from browser-localStorage to a DB-backed model. The existing Settings UI's privacy framing ("stored only in this browser") is replaced by "stored in your local database, never leaves your machine in Tier 1."

### Non-goals (V1)

- Multi-provider UI (V1 ships Anthropic only; schema supports more).
- Per-feature model override (V1 uses one default model per provider for everything).
- Encryption-at-rest on stored API keys (Tier 1 — your machine, your DB; Tier 4 will need this).
- Cost / usage metering (Tier 4 concern).
- Streaming (story generation in particular would benefit; deferred).
- Web-UI parity with the rich Claude Code skill workflow — the web UI keeps doing one-shot LLM calls in V1 (see "Web UI ↔ Claude Code asymmetry" below).
- Eager validation on save (V1 has a user-triggered Test button instead).

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| AI abstraction | Vercel AI SDK (`npm:ai` + `npm:@ai-sdk/anthropic` and friends) | Custom thin abstraction; OpenRouter as sole provider; per-provider SDKs with switch. |
| Key storage | DB-backed `user_settings` table, RLS-scoped, plain text | localStorage; OS keychain; hybrid DB+localStorage. |
| Provider config model | Multi-provider schema, one active default per user | Single active provider only; per-feature override. |
| V1 provider scope | Anthropic only, with multi-provider schema for forward-compat | Big four (Anthropic+OpenAI+Gemini+Ollama); everything AI SDK supports; Anthropic+Ollama. |
| Key flow into edge functions | Server-side lookup by `auth.uid()` | Client-side passing in request body. |
| Validation | Lazy on use + user-triggered Test button | Eager on save. |
| Wrapper organisation | Single `_shared/ai.ts`; edge functions never import AI SDK directly | Direct imports in each edge function. |
| Web search for discovery | Anthropic's built-in web search tool | Keep Serper as the search provider. |
| Gemini migration | Hard cutover — delete Gemini code, no transitional dual-support | Side-by-side; bootstrap migration that ports `GEMINI_API_KEY` env to a `user_settings` row. |
| Web UI orchestration richness | One-shot LLM calls (existing pattern) — accept asymmetry with Claude Code in V1 | Replicate orchestration as TS in edge functions; run an agentic Claude loop in edge functions sharing the plugin's skills. |

## Schema

New table:

```sql
create table user_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,                    -- 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'openai-compatible'
  api_key text,                              -- nullable for Ollama (no key); plain text in V1
  base_url text,                             -- for openai-compatible / Ollama: custom endpoint
  default_model text,                        -- e.g. 'claude-sonnet-4-6'; null = wrapper-side default
  is_default boolean not null default false,
  last_used_at timestamptz,                  -- updated by wrapper after successful calls
  last_error_at timestamptz,                 -- updated on failed calls
  last_error_code text,                      -- 'invalid_api_key' | 'rate_limited' | etc.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table user_settings enable row level security;

create policy "users manage own settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Exactly one default per user
create unique index user_settings_one_default
  on user_settings(user_id) where is_default;
```

Schema is multi-provider from day one. V1 UI inserts only Anthropic rows. V1.1 widens the UI without schema changes. The `base_url` field unlocks OpenAI-compatible custom endpoints (Ollama, MiniMax, OpenRouter) without per-provider code work.

## Provider abstraction

`supabase/functions/_shared/ai.ts` replaces `_shared/gemini.ts` (which is deleted). Single entry point that all AI-using edge functions call.

```typescript
// supabase/functions/_shared/ai.ts
import { generateText, generateObject } from 'npm:ai';
import { createAnthropic } from 'npm:@ai-sdk/anthropic';
import { z } from 'npm:zod';
import { createClient } from 'jsr:@supabase/supabase-js';

type Provider = 'anthropic';   // V1 union; V1.1 widens

type AISettings = {
  provider: Provider;
  api_key: string;
  default_model: string | null;
  base_url: string | null;
};

export class AIProviderNotConfigured extends Error { /* ... */ }

// Read the calling user's active provider via auth.uid().
// Throws AIProviderNotConfigured if no row exists.
export async function getUserAI(req: Request): Promise<AISettings> { /* ... */ }

// Build an AI SDK model handle for the configured provider.
export function buildModel(s: AISettings, modelOverride?: string) {
  switch (s.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: s.api_key });
      return anthropic(modelOverride ?? s.default_model ?? 'claude-sonnet-4-6');
    }
    // V1.1: case 'openai', case 'google', case 'openai-compatible' (uses base_url), etc.
  }
}

// Convenience wrappers — these are what edge functions call.
export async function generate(req, opts: { prompt: string; model?: string; tools?: string[] }): Promise<string>;
export async function generateStructured<T>(req, opts: { prompt: string; schema: z.ZodSchema<T>; model?: string; tools?: string[] }): Promise<T>;
export async function generateFromImage(req, opts: { imageUrl: string; prompt: string; model?: string }): Promise<string>;

// V1.1 backlog seam — runs an agentic Claude loop with the same skills the plugin uses
// export async function runAgent(req, opts: { skill: string; tools: ToolDef[]; maxSteps?: number }): Promise<string>;
```

Implementation properties:

- **Auth pivot.** `getUserAI(req)` extracts the JWT from `Authorization`, builds a Supabase client scoped to that JWT, and queries `user_settings` for the row where `is_default = true`. RLS enforces user scoping; no explicit `user_id` filter needed.
- **Three call shapes** cover the existing edge functions: free-form text (scrape fallback), structured output with Zod schema (discovery), multimodal image input (image extraction).
- **Retry policy.** Wrapper performs ONE automatic retry after `retry_after` seconds (or 5s default) on 429. Bubbles up after that.
- **Error sanitisation.** Wrapper strips request bodies from forwarded errors; only status, provider error code, and a generic message reach the caller. Important for Tier 4 logs.
- **Result tracking.** Wrapper updates `last_used_at` on success, `last_error_at` + `last_error_code` on failure. Costs one UPDATE per call; powers the Settings status line.
- **No env fallback** in V1. If `getUserAI` finds no row, it throws. Tier 4 will gate an env fallback on `PLANNEN_TIER=hosted` (see "Forward-compat for Tier 4" below).

## Edge function changes

### `agent-discover/index.ts`

- LLM path: `await generateStructured(req, { prompt, schema, tools: ['web_search'] })`.
- Search infrastructure: **Serper deleted**. Anthropic's built-in `web_search` tool replaces it. AI SDK exposes this via the `tools` field. When V1.1 ships providers without built-in search, decide per provider (re-introduce a search field, use grounding, or accept degraded discovery).
- Error path: `AIProviderNotConfigured` → 400 with `{ error: 'no_provider_configured' }`.

### `agent-extract-image/index.ts`

- `await generateFromImage(req, { imageUrl, prompt })`.
- Default model (`claude-sonnet-4-6`) is vision-capable; no override needed.
- When V1.1 ships non-vision providers, the UI must hide / disable this feature for those users (multimodal capability matrix in the wrapper).

### `agent-scrape/index.ts`

- Regex extraction unchanged.
- LLM fallback: `await generateStructured(req, { prompt, schema })`.

### Functions that don't change

`agent-monitor`, `send-remind`, `get-google-auth-url`, and the other six functions — none call an LLM today, none after.

### Deletions

- `supabase/functions/_shared/gemini.ts`.
- `GEMINI_API_KEY` and `SERPER_API_KEY` references in `.env*`, docs, and code paths.

## Web app settings UI

New page at `src/pages/Settings.tsx`, route `/settings`, linked from a header / nav element.

V1 layout (Anthropic-only):

```
┌─ Settings ─────────────────────────────────────────────┐
│                                                         │
│  AI Provider                                            │
│  ─────────────────────────────────────────────────      │
│  Plannen uses an AI model for discovery, story          │
│  generation, and event extraction. Bring your own key.  │
│                                                         │
│  Provider:    ● Anthropic                               │
│               ○ More providers coming soon              │
│                                                         │
│  API key:     [••••••••••••••••]  [Show]  [Test]        │
│               Get a key at console.anthropic.com        │
│                                                         │
│  Model:       [claude-sonnet-4-6     ▾]  (optional)     │
│                                                         │
│  Status:      ✓ Saved · last used 2 minutes ago         │
│               (or)                                      │
│  Status:      ⚠ Last call failed: invalid API key       │
│                                                         │
│                                          [ Save ]       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Implementation notes:

- Single form, single Save button. Save is fast — no validation round-trip.
- Test button is user-triggered eager validation. Calls `POST /v1/messages` with a tiny prompt (cheaper than `/v1/models` and proves auth + model access in one shot). Result rendered inline.
- Key field is masked by default with a Show toggle.
- Model dropdown is pre-populated with current public Anthropic models (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Default is `claude-sonnet-4-6`.
- Status line reads `last_used_at` / `last_error_at` / `last_error_code` from `user_settings` so the user sees the most recent state without retrying.

When no provider is configured, AI features in the rest of the app show a banner: "Configure an AI provider in Settings to use this feature → /settings".

Forward-compat for V1.1:

- The provider radio becomes a list of cards (Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible). Each card has its own key field. One is marked default.
- The "More providers coming soon" placeholder is V1 honesty — UI shape is built, backend supports it, only the curated list is gated.

## Failure modes

The existing `_shared/claude.ts` throws unstructured `Error("Claude API error 401: …")` strings. V1 replaces this with the typed error codes below — every callsite gets a stable code it can branch on.

| Condition | Error code | Edge function returns | Web app surfaces | Plugin (`plannen-core`) surfaces |
|---|---|---|---|---|
| No provider configured | `no_provider_configured` | 400 | Banner: "Configure an AI provider in Settings → /settings" | Reply: "Plannen has no AI provider configured. Open the web app at /settings, or run /plannen-setup." |
| Invalid key (401) | `invalid_api_key` | 400 | Banner: "Your Anthropic key isn't working — check Settings" | Same as above + "the saved key is being rejected" |
| Rate-limited (429) | `rate_limited` | 429 + `retry_after` | Toast: "AI provider rate-limited. Try again in N seconds." | Skill instructs the agent to wait + retry once, then surface |
| Provider unreachable | `provider_unavailable` | 502 | Toast: "Couldn't reach AI provider. Check connection or status page." | Same, with hint to check the provider's status page |
| Model unavailable | `model_unavailable` | 400 | Banner: "Your account can't access [model]. Pick a different model in Settings." | Same |
| Unexpected | `unknown_error` | 500 + sanitised | Toast: "Something went wrong" + console error | Skill replies with raw error so user can debug |

## Forward-compat for Tier 4 (out of V1 scope)

Tier 4 (hosted Plannen) ships an env-fallback so users without their own key hit the platform-paid path. The wrapper has the seam ready:

```typescript
// Future _shared/ai.ts → getUserAI()
export async function getUserAI(req: Request): Promise<AISettings> {
  const userRow = await readUserSettings(req);
  if (userRow) return userRow;

  // Tier 4 only — gated on deploy-time env so Tier 1 OSS deploys never accidentally pay.
  if (Deno.env.get('PLANNEN_TIER') === 'hosted') {
    return {
      provider: 'anthropic',
      api_key: Deno.env.get('ANTHROPIC_API_KEY')!,
      default_model: 'claude-sonnet-4-6',
      base_url: null,
    };
  }
  throw new AIProviderNotConfigured();
}
```

Three properties this preserves:

1. Tier 1 (OSS) deploys cannot accidentally hit a paid path — the fallback is gated on `PLANNEN_TIER=hosted`.
2. Edge function code doesn't change between tiers.
3. Per-user keys still take priority on hosted; only users without keys hit the platform fallback.

Adjacent Tier 4 concerns (encryption-at-rest, cost metering) attach to the same module when that tier ships.

## Web UI ↔ Claude Code asymmetry

The richest Plannen workflows (discovery with profile context + source search + web search + composition; story creation with photo sampling and memory loading) are orchestrated by Claude in the user's session via plugin skills. They make many tool calls and reason across them.

The web UI's edge functions are one-shot LLM calls. They don't load profile context, don't search saved sources, don't reason multi-step — they take a prompt and return a result.

This asymmetry exists today (web UI Gemini one-shot vs Claude Code rich skill workflow) and **persists in V1 BYOK**. The BYOK swap doesn't regress anything; it just changes the LLM provider underneath.

Closing the gap is out of V1 but is the natural V1.1+ direction. Three options for how:

- **(A)** Accept asymmetry permanently. Web UI is intentionally simpler; Claude Code is the rich surface.
- **(B)** Replicate orchestration as TypeScript in each edge function. Logic lives in two places (markdown skill + TS code); risk of drift.
- **(C)** Run an agentic Claude loop *inside* the edge function with the same skill markdown the plugin uses, plus AI-SDK tool definitions that mirror MCP tools. Skill becomes single source of truth; runs in Claude Code via the agent loop, runs in web UI via the edge-function loop.

**V1 ships (A). V1.1+ targets (C).** Backlog item below.

The wrapper module's design preserves the seam for (C): a future `runAgent(req, { skill, tools, maxSteps })` function is a natural extension. The shared-services layer that (C) requires (`services/` consumed by web UI, MCP, and AI-SDK tools) is already half-present per `TIERED_DEPLOYMENT_MODEL.md` line 94 ("the MCP server wraps the same service functions the web app uses").

## Backlog (explicit deferrals)

### Near-term (V1.1)

1. **Additional curated providers.** Gemini, OpenAI, Ollama as their own UI cards, each with a tested default model. Schema, wrapper switch, and import map already accommodate them — V1.1 is mostly UI work plus one wrapper case per provider.
2. **Generic OpenAI-compatible endpoint.** A "Custom (OpenAI-compatible)" card with `base_url` field. Unlocks MiniMax, OpenRouter, locally-hosted models, anyone with an OpenAI-shaped endpoint.
3. **Multimodal capability matrix.** When non-vision providers ship, `agent-extract-image` must hide / disable for those users. Wrapper detects vision-capable models; UI gates the feature.
4. **Web search story for non-Anthropic providers.** Decide per provider when V1.1 ships them: re-introduce a per-provider Serper field, use Gemini's grounding, or document degraded discovery.

### Medium-term

5. **Per-feature model override.** Settings UI "advanced" expander: stories use opus, discovery uses sonnet, etc. Default in V1 is uniform.
6. **Eager validation on save (toggle).** Auto-run Test on every save for users who prefer the safety net. Non-blocking; small UX win.
7. **Streaming for story generation.** Long output benefits visibly. Requires SSE or chunked response in the edge function and a streaming handler in the web app.

### V1.1+ (closing the asymmetry)

8. **`runAgent` wrapper function.** Edge-function-side agentic Claude loop that consumes the same skill markdown the plugin uses. Lets web UI achieve workflow parity with Claude Code on stories, discovery, etc.
9. **Shared AI-SDK tool definitions.** Tool wrappers around the existing service functions — exposed simultaneously via MCP (for Claude Code) and AI SDK (for `runAgent`). Single tool surface, two consumers.

### Future (Tier 4 hosted)

10. **Encryption-at-rest** on `user_settings.api_key` (Supabase Vault or libsodium envelope).
11. **Cost / usage metering.** Per-user token counts, hard caps, dashboards. Wrapper is the natural seam.
12. **Hosted env-fallback.** Designed in "Forward-compat for Tier 4" above; code path doesn't exist in V1.

### Quality-of-life

13. **Bulk / batched calls.** "Analyse my sources" runs N sequential calls today; could batch into one structured-output call.
14. **Provider auto-fallback on rate-limit / outage.** When user has multiple providers configured (V1.1+), retry on a secondary when primary fails.
15. **Cross-CLI BYOK surface.** Cross-references plugin-spec backlog #9. `user_settings` is host-agnostic; CLIs need their own surfaces (rules, agents) to reference it.

## Risks & open questions

- **Anthropic web search availability via AI SDK.** AI SDK exposes Anthropic's web search tool, but tool definitions and limits should be verified during implementation. If unavailable in the SDK version we land on, fall back to using Anthropic SDK directly for `agent-discover` only, or reintroduce Serper as a transitional measure.
- **Multimodal in V1.** `agent-extract-image` requires `claude-sonnet-4-6` or above. Settings UI should warn / prevent picking `claude-haiku-4-5` (no vision) as the default model. Validate during implementation.
- **`getUserAI` performance.** One DB query per AI call. Negligible for current volumes; revisit if it becomes hot. Cache-by-user-id with short TTL is the natural fix.
- **Migration of maintainer's setup.** The user (Plannen maintainer) currently has `GEMINI_API_KEY` in env. V1 hard cutover means he must switch to Anthropic before deploying BYOK or AI features will be unavailable. Documented; no automated migration.

## Cross-references

- `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` — plugin architecture; references `_shared/ai.ts` indirectly via the failure-mode surfacing in `plannen-core`.
- `docs/TIERED_DEPLOYMENT_MODEL.md` — the BYOK strategy this implements (Tier 1 / Tier 2 / Tier 3).
- Memory: `project_deployment_model.md`.
- Future spec: `2026-MM-DD-oss-blockers-design.md` (next brainstorm).
- Future spec: `2026-MM-DD-bootstrap-and-setup-story-design.md` (after blockers).
