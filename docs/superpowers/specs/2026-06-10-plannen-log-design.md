# `/log` — ambient frictionless journal for Plannen

**Status:** Approved (2026-06-10)
**Scope:** Phase 1 — prompt-only plugin skill + command over existing MCP primitives. No new MCP tools, no DB migration.

## Problem

Plannen today is biased toward *planning ahead*: the event-creation intent gate defaults to "want me to save this?" before it writes anything. There is no low-friction way to *record what just happened* — a finished chore, a completed routine, a person you met. Users want a single verb that captures a fact and files it in the right place without ceremony, the way a journal does.

## What we're building

A capture path with three entry points, all routing to one set of rules:

1. **`/plannen-log` slash command** (surfaced/spoken as `/log`) — explicit, always acts.
2. **Logging lead-ins** in chat — "log…", "note that…", "jot…", "record…".
3. **Bare past-tense reports** — "finished the parking", "kids are in bed", "just met our new neighbour" — no keyword required.

All three trigger **act-immediately → one-line receipt with an undo hint**, explicitly bypassing the event-creation intent gate. This journal override is the one sanctioned exception to plannen-core's "ask first" default, and is documented as such in `plannen-core.md`.

### Mental model (decided)

- **Frictionless journal** — center of gravity is recording things that *already happened*; quick-capture of the occasional future todo is secondary.
- **Act, then report** — always take the best-guess action immediately and print a brief receipt; rely on easy undo for the rare wrong guess.
- **Ambient trigger** — any clear past-tense report fires the behavior, not just an explicit keyword.

## Routing table

`/log <text>` (or an ambient report) classifies into exactly one of these, acts, then prints a one-line receipt:

| Input shape | Example | Action | Receipt |
|---|---|---|---|
| Future / timed task | "log call dentist at 1pm" | `create_event({ title, start_date, event_kind: 'todo' })` | `✓ Todo "call dentist" · today 13:00 · undo?` |
| Past-tense done | "just finished gym today" / "finished cleaning the parking" | **Three-tier resolve (first match wins):** (1) existing open todo matches → `complete_todo({ id })`; (2) active practice matches → `mark_practice_done({ practice_id })`; (3) neither → `create_event(todo, now)` → `complete_todo`. Avoids duplicating an already-planned item; **never** auto-creates a routine. | `✓ Done "<title>" · undo?` (tier 1) / `✓ Marked "Gym" done · today · undo?` (tier 2) / `✓ Logged + done "<title>" · undo?` (tier 3) |
| Person / place / attribute | "met person A, lives on my street" | `upsert_profile_fact({ subject, predicate, value, source: 'user_stated' })` | `✓ Noted: A lives on your street · undo?` |
| Activity / time-block | "slept 8h last night" | *(Phase 2 — no table yet)* graceful notice, no write | `⏳ Sleep/duration logging isn't wired up yet — coming soon` |

### Tie-breakers (since we chose "act, then report")

- Past-tense / completion words ("finished", "did", "done", "just …ed") → done-todo or practice-completion.
- A specific future time/date → future todo.
- "met / lives / works / allergic / prefers / their …" → profile fact.
- "log gym" with **no** matching active practice → completed todo stamped now, **not** a new routine. Creating routines is a heavier, gated action that stays out of `/log`.

## Guard rails (the cost of "any past-tense report")

The ambient trigger is the main hazard: "I finished the parking" must be recorded, but "I should finish the parking" / "did you finish the parking?" must not be.

- Act ONLY on **completed, concrete, first-person / household actions stated as fact**.
- **Do NOT act** on: questions ("did you…?"), intentions / hypotheticals ("I should…", "maybe I'll…", "thinking about…", "we might…"), narration about others' unactionable doings, or anything inside an active brainstorm / planning thread.
- When a report is genuinely borderline, the journal default still applies — the receipt + one-word undo keep the cost of a wrong guess minimal.

## Receipts & undo

- **Every** action the skill takes prints a brief, single-line receipt ending in `undo?` — including profile facts (unlike plannen-core's *silent* passive capture, because here the user is explicitly logging and should see it landed).
- Receipt format: `✓ <what happened> · <when/where if useful> · undo?`. Times in 24h `HH:MM`. No prose, no coaching.
- **Undo needs no new infrastructure.** The skill remembers the last action it took and reverses it on "undo":
  - future/done todo → `uncomplete_todo` (if completed) then delete/cancel the event
  - practice completion → `unmark_practice_done({ practice_id, completed_on })`
  - profile fact → `correct_profile_fact` (mark historical)

## Where the code lives

- `plugin/commands/plannen-log.md` — entrypoint; parses `$ARGUMENTS`, invokes the `plannen-log` skill, one-shot (no follow-up questions). Mirrors `plannen-today.md`.
- `plugin/skills/plannen-log.md` — the routing table, tie-breakers, guard rails, receipt rules, undo. Description written to auto-activate on logging lead-ins and bare past-tense reports.
- `plugin/skills/plannen-core.md` — add a short "Logging (the `/log` journal override)" block: names the trigger, states that `/log` and clear past-tense reports **bypass** the event-creation intent gate, and points to the `plannen-log` skill. Cross-references the existing profile-extraction rule so the two don't double-fire.

## Cross-surface portability (mobile) — the `log_completion` tool

The plugin skill only loads in Claude Code / Desktop. The **claude.ai mobile app** connects over remote MCP and loads no plugin — so the routing/guard-rails/dedup must travel through channels mobile actually reads: **MCP server `instructions`** and **tool descriptions**. The user is mobile-first, so this is in scope, not deferred.

**Architecture: C-thin.** Mobile's Claude does the *classification* (it's already a capable LLM); a new server-side tool does the *deterministic, dedupe-safe part*. No server-side LLM / BYOK needed.

- **New MCP tool `log_completion({ title, when?, family_member_id? })`** — added in **both** runtimes (`mcp/src/index.ts` and `supabase/functions/mcp/tools/events.ts`), parity-checked. Runs inside the existing per-call transaction and resolves the completion three-tier, **first match wins**:
  1. existing **open todo** with a confident single title match → complete it (no duplicate);
  2. else active **practice** with a confident single name match → log a completion;
  3. else **log a fresh completed todo**.
  Matching is **conservative** (exact normalized match, or a single recent/contains match — never guess among 2+). Returns `{ action: 'completed_todo' | 'marked_practice' | 'logged_todo', … }` so the caller renders the right receipt.
- **MCP server `instructions`** (`PLANNEN_INSTRUCTIONS`, set in `server.ts` + the local server) carry the compact routing table + guard rails to every client, mobile included. Kept in sync across both runtimes.
- The `plannen-log` skill now **calls `log_completion`** for the completion case instead of hand-rolling `list_events → filter → complete` — single source of truth.

No migration: `log_completion` reuses existing tables (`events`, `practices`, `practice_completions`).

On mobile the *future-todo* and *profile-fact* cases route to the already-existing `create_event` / `upsert_profile_fact` tools, guided by the server instructions.

## Test matrix

Manual / behavioral acceptance (this is a prompt skill — verified by exercising the trigger phrases):

1. `/log call dentist at 1pm` → future todo created at 13:00, receipt shown, not auto-completed.
2. "finished cleaning the parking" (no keyword) → todo created + completed, single receipt.
3. "log gym" with an active gym practice → `mark_practice_done`, not a new event.
4. "log gym" with no gym practice → completed todo, **no** practice created.
5. "met our new neighbour, lives on our street" → `upsert_profile_fact`, receipt shown (not silent).
6. "slept 8h last night" → graceful "coming soon" notice, no write.
7. "should I finish the parking?" / "I might clean the garage later" → **no action** (guard rail).
8. "undo" after #2 → todo re-opened and removed.

## Out of scope (Phase 2+)

- `activity_logs` table + `log_activity` / `list_activity_logs` MCP tools (both runtimes) for sleep/exercise/duration time-blocks.
- Web UI surface for logged activities.
- Auto-creating routines from `/log` (stays gated).
