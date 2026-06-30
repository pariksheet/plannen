# UI Action Agent — design

**Date:** 2026-06-30
**Status:** Approved (brainstorm)

## Problem

Plannen's natural-language layer today lives entirely in **external Claude
clients** — Claude Code CLI, Claude Desktop, and the claude.ai connector — which
drive the MCP edge function (`supabase/functions/mcp/`) to create events, tick
checklists, and log activity. A user sitting in the **web app** has no equivalent:
to create or edit an event they must open forms and fill fields by hand. The only
AI affordance in the web UI is the **Discover** button, which does web event
discovery via the `agent-discover` / `agent-scrape` edge functions.

We want a small, **scoped action agent inside the web UI**: the user types
"add swimming Friday 4pm" or "cancel the dentist appointment" and the app performs
the action. Crucially, this agent must run on an **app-provided model** (an
OpenAI-compatible API offered as part of the product, not a per-user BYOK key),
metered with a **daily per-user limit**, and it must stay narrowly scoped to
Plannen functionality — it is **not** a general chatbot.

## Goal

A web-app agent that, from one repurposed entry point, lets a user perform a
**fixed set of Plannen actions** in natural language:

1. **Create** an event (all kinds: event / reminder / todo / container).
2. **Update / edit / cancel** an event (cancel = `event_status: 'cancelled'`).
3. **Add** a new item to a checklist.
4. **Check / uncheck** a checklist item.
5. **Log** an activity.

…and nothing else. Off-topic, general-knowledge, and jailbreak inputs are
declined, not answered.

## Key distinction: where inference happens

This design hinges on understanding that the **MCP edge function runs no LLM**. It
is pure tool execution — it receives a tool call, hits the DB under RLS, returns
the row. All *intelligence* on the CLI/Desktop/claude.ai paths is supplied by the
**user's own Claude client** (their subscription / own setup). Those paths
therefore consume **none** of our inference budget.

The new UI agent is the **only** surface where the app runs its **own** inference
loop server-side, and therefore the only surface that needs an app key and a quota.

| Surface | Who runs inference | Key used | Metered by us? |
|---|---|---|---|
| Claude Code CLI / Desktop / claude.ai | the user's Claude client | user's subscription / own | no |
| **New UI action agent** | **our `agent-chat` fn** | **app OpenAI-compatible key** | **yes — 100/day** |
| Existing web Discover (being shelved) | edge fn | user BYOK Anthropic | no quota today |

## Scope (v1)

In scope:

- A new **`agent-chat`** Supabase edge function that runs an OpenAI-compatible
  tool-calling loop server-side and **imports the existing MCP `ToolModule`
  dispatch handlers directly** (no HTTP/JSON-RPC hop).
- A new **`AgentChat`** web component, opened by repurposing the **Discover**
  button (`DiscoverButton.tsx`), reusing the existing `Modal`.
- The 5 write actions above, plus a minimal set of **lookup** tools for the
  search-fallback resolution path.
- An **app-level OpenAI-compatible provider** wired via the Vercel AI SDK
  (`@ai-sdk/openai-compatible`), configured by app secrets.
- A **per-user daily quota** (100 model-invoking requests/day), hard-blocking at
  the limit, backed by a new `plannen.agent_usage` table.
- A **confirmation flow** for destructive and search-resolved actions.
- **Bounded conversation context** (current task + 1 prior completed task).

Out of scope (v1):

- **Tier 0 (local single-user).** This is the hosted offering (app key + quota);
  v1 targets **Tier 1/2** only. Tier 0 support is a possible follow-up.
- **General conversation** of any kind — explicit non-goal (see below).
- **Streaming** responses — responses are short receipts/confirmations; v1 is
  non-streaming. Streaming is a later enhancement.
- Deleting or rewriting the existing `agent-discover` / `agent-scrape` functions —
  they are **unwired from the button but left deployed**, so the change is
  reversible.
- New write actions beyond the 5 (no delete-event, no checklist deletion, no
  family/profile edits, etc.).

## Architecture

### Surface & UX

- The **Discover** entry in the MyFeed header (`src/components/DiscoverButton.tsx`)
  is repurposed to open the new **`AgentChat`** component inside the existing
  reusable `Modal` (`src/components/Modal.tsx`).
- `AgentChat` is a message-list + input panel (Lucide icons; `useToast` for
  receipts), modeled on the existing `EventDiscoveryForm` async pattern
  (`loading` / `error` / `results`) but as a turn-based thread.
- The panel renders a running log of the task thread. When the daily quota is
  exhausted, the input is **disabled** with a "resets at midnight" message.
- Web discovery (`agent-discover` / `agent-scrape`) is **shelved**: unwired from
  the button, left deployed.

### Request path

- The web calls the new function via the established
  `dbClient.functions.invoke('agent-chat', payload)` path. Auth/session is
  already handled by that client — **no new auth or transport plumbing**.
- Request payload (web → `agent-chat`):
  ```jsonc
  {
    "messages": [ /* bounded window: current task + 1 prior task, ≤6 msgs */ ],
    "context": { "open_event_id": "…?", "open_checklist_id": "…?" },
    "confirm": { /* present only on a confirm tap; see Confirmation flow */ }
  }
  ```
- Response shape (`agent-chat` → web):
  ```jsonc
  {
    "assistant_text": "…",                 // receipt or decline or question
    "proposed_action": { /* tool + args + human summary */ } | null,
    "executed_action": { /* tool + result summary */ } | null,
    "usage": { "used": 7, "limit": 100, "resets_at": "…ISO…" },
    "error": null
  }
  ```

### Inference loop (`agent-chat`)

1. Resolve `userId` from the Supabase session; build **one** `ToolCtx` and set the
   RLS context once (same mechanism the MCP server uses).
2. **Quota check** against `plannen.agent_usage` for today (profile TZ). If at the
   limit → return a hard-block response without calling the model.
3. Build the system prompt (scope guard + tool list + **current datetime in the
   user's profile TZ**).
4. Run an OpenAI-compatible tool-calling loop via `@ai-sdk/openai-compatible`
   (`createOpenAICompatible({ baseURL, apiKey })` → `generateText({ tools })`),
   with an **internal tool-call cap** (≤5 per user message) to bound cost and stop
   a small model from looping.
5. On each tool call, dispatch **directly** to the imported handler, e.g.
   `eventsModule.dispatch.create_event(args, ctx)` — identical code, RLS, and
   timezone parsing to the MCP path. No parity risk.
6. Increment the daily counter (see Quota) and return.

### Provider

- Vercel AI SDK's `@ai-sdk/openai-compatible` (the repo already uses the AI SDK
  for Anthropic).
- App-level **edge-function secrets**, read server-side, never in `user_settings`:
  - `LLM_API_KEY` — the app's OpenAI-compatible key.
  - `LLM_BASE_URL` — the provider endpoint.
  - `LLM_MODEL` — the model id (e.g. a ~27B-class instruct model with native
    function calling). Model is a config value, so it can be swapped after an eval.

## Tools exposed to the agent

**Writes (the 5 actions):**

- `create_event` — all kinds via `event_kind`.
- `update_event` — edits and **cancel** (`event_status: 'cancelled'`).
- `add_checklist_items`
- `check_checklist_item`
- `uncheck_checklist_item`
- `log_activity`

**Lookups (search-fallback resolution only):**

- `list_events`, `list_checklists`, `get_checklist` (and `get_event` if needed).

Nothing else is registered — this bounds both scope and the small model's load.

## Entity resolution

Three of the five actions operate on an **existing** record. Resolution is
**context-scoped by default, with a search fallback**:

- **Context-scoped (default):** the web passes the current UI context
  (`open_event_id` / `open_checklist_id`) with each request; write tools target
  that record when the instruction is clearly about "this."
- **Search fallback:** when there is no obvious target ("cancel swimming Friday"
  from anywhere), the agent uses the lookup tools to find the record.

## Confirmation flow

Confirm **destructive** (cancel) and **search-resolved** actions; clear-context
creates / edits / checklist ticks execute directly.

Mechanism (stateless-safe — edge functions hold no session state):

1. When confirmation is required, the agent **does not execute**. It returns a
   `proposed_action` (tool name + fully-resolved args + a human summary, e.g.
   "Cancel **Swimming, Fri 18:00**?").
2. The UI renders Confirm / Cancel.
3. On **Confirm**, the web re-invokes `agent-chat` with the proposal echoed back in
   `confirm`. The server validates and **executes the tool directly — no LLM
   call.** On **Cancel**, the proposal is discarded client-side.

Because the confirm step runs no inference, **a confirm tap does not cost a
request** (see Quota).

## Scope guard (no general chatbot)

Explicit non-goal: **no general-purpose conversation.**

- The system prompt states the agent handles only Plannen events, checklists, and
  activity logging, and must decline everything else with a **fixed canned line**
  (e.g. "I can only help with your plans, checklists, and activity — try 'add
  swimming Friday 4pm'.").
- There is **no free-form generation affordance**: if a message does not resolve
  to one of the registered tools, the turn ends in the canned decline rather than
  a generated answer. Off-topic Q&A, general knowledge, and "ignore your
  instructions" attempts all dead-end identically.
- Declines **still cost 1 request** (they invoke the model), so abuse cannot drain
  free inference beyond the user's own daily quota.

## Quota

- **Unit:** one **model-invoking** user message = **1 request**. Confirm taps and
  proposal executions invoke no model and **do not count**.
- **Limit:** **100 requests / user / day.**
- **At limit:** **hard-block** — the model is not called; the response carries a
  friendly "you've used today's 100 assistant requests, resets at midnight"
  payload and the UI disables input.
- **Reset boundary:** **midnight in the user's profile timezone** (consistent with
  event bucketing).
- **Storage:** new table
  ```sql
  CREATE TABLE plannen.agent_usage (
    user_id       uuid    NOT NULL,
    usage_date    date    NOT NULL,   -- computed in the user's profile TZ
    request_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
  );
  ```
  RLS-scoped to the owner. Counter is incremented atomically and **checked before**
  each model call. Added as an additive forward-only migration under
  `supabase/migrations/` and applied via `npx plannen migrate` on every active
  Tier 1/2 profile.

## Conversation context

- Rolling but **bounded**: **current task + at most 1 prior completed task**,
  capped at ~6 messages / a token ceiling.
- A **task** = an instruction plus its confirmations and immediate refinements; it
  closes when a write action succeeds. The next message may still refine the
  just-closed task ("actually make it 5pm"); once a clearly new instruction
  arrives, the closed task ages out of the window.
- **Hard resets:** on panel close or an explicit "start over." The window is
  managed client-side and sent with each request.

## Date / time handling

- The system prompt injects the **current datetime in the user's profile TZ** so
  relative phrases ("tomorrow 3pm", "Friday") resolve correctly.
- Existing handlers already parse naive timestamps in the user's TZ
  (`parseInUserTz`), so no new date logic is needed server-side.

## Components / interfaces (summary)

| Unit | Responsibility | Depends on |
|---|---|---|
| `AgentChat` (web) | thread UI, bounded-window management, confirm UI, quota display | `Modal`, `dbClient.functions`, `useToast` |
| `DiscoverButton` (web, repurposed) | open `AgentChat` | `AgentChat` |
| `agent-chat` (edge fn) | quota gate, inference loop, tool dispatch, confirm execution | MCP `ToolModule` dispatch maps, `@ai-sdk/openai-compatible`, `agent_usage` |
| `plannen.agent_usage` (table) | per-user daily request count | RLS |
| app secrets | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | — |

## Risks & mitigations

- **Small-model tool-calling reliability** → narrow tool set, context-scoped
  resolution by default, confirmations on the risky paths, and an internal
  tool-call cap. Model is config-swappable; validate with a small eval harness
  against the real tool schemas before committing a model.
- **Wrong record on search fallback** → search-resolved actions always confirm.
- **Date/TZ errors** → datetime injected in profile TZ; handlers parse in TZ.
- **Cost/abuse** → hard daily cap; declines and off-topic prompts count; tool-call
  cap bounds per-message cost.

## Open questions

None blocking. Model selection (the specific OpenAI-compatible model) is a config
value to be finalized after a quick eval against the real tool schemas.
