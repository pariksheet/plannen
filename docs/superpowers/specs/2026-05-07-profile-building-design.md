# Incremental Profile Building — Design Spec
_Date: 2026-05-07 · Branch: feat/plannen-tier-1_

---

## Problem

A person can't be captured in a fixed schema. Interests, preferences, schools, allergies, favourite shows, routines — a human profile has hundreds of dimensions that no set of columns can anticipate. And people change: Niheet loved dinosaurs at 4, loves football at 5, and will love something else at 10. Old facts don't disappear — they become historical context.

The goal is a growing, weighted, temporal knowledge graph that the agent builds silently through natural conversation — no forms, no interrogation.

---

## Scope

- Claude Code / Claude Desktop only (AgentChat via MCP). Web chat interface is a future concern.
- Subjects: the user themselves and their family members.
- Storage: new `profile_facts` table. Existing `user_profiles` and `family_members` tables unchanged.

---

## Section 1: Data Layer

### `profile_facts` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users.id | for RLS |
| `subject` | TEXT | `"user"` or a `family_members.id` UUID |
| `predicate` | TEXT | free-form, e.g. `likes`, `goes_to_school_at`, `allergic_to`, `prefers_time_of_day` |
| `value` | TEXT | the fact value |
| `confidence` | FLOAT | 0.0–1.0 |
| `observed_count` | INT | increments on each corroboration, default 1 |
| `source` | TEXT | `agent_inferred` or `user_stated` |
| `is_historical` | BOOLEAN | default false |
| `first_seen_at` | TIMESTAMPTZ | set on insert |
| `last_seen_at` | TIMESTAMPTZ | updated on each corroboration |

**RLS:** `user_id = auth.uid()` — strictly private, no sharing policies.

### Confidence rules

| Event | Effect |
|-------|--------|
| Agent infers new fact | `confidence = 0.7`, `source = agent_inferred` |
| User explicitly states new fact | `confidence = 1.0`, `source = user_stated` |
| Corroboration (same predicate + value) | `confidence += 0.1` (cap 1.0), `observed_count++`, update `last_seen_at` |
| Contradiction (same predicate, different value) | Old fact: `confidence -= 0.3`; if `< 0.4` → `is_historical = true`. New fact: insert at 0.7 or 1.0 |
| User explicit correction | Old fact: `is_historical = true`. New fact: `confidence = 1.0`, `source = user_stated` |

---

## Section 2: Agent Behavior

### Extraction triggers

Claude looks for candidate facts when the user:
- References a family member's school, activity, or routine ("drop Niheet at Esdoorn")
- States a personal preference ("I prefer mornings", "we don't eat meat")
- Mentions a recurring location ("our usual spot", "the pool in Hombeek")
- Describes a characteristic or interest ("Niheet is really into football lately")

### Save rule

After any MCP tool call that creates or updates an event, check if the conversation revealed a new or corroborating profile fact. If yes, call `upsert_profile_fact` once before responding. **Never mention it to the user unless they ask.**

At most **one fact saved per conversation turn** — prioritise the highest-confidence inference. This prevents profile-spam during information-dense conversations.

### Contradiction rule

If the user says something that contradicts a known fact, call `correct_profile_fact` silently and continue. Only surface it if the correction is significant (e.g. "I've updated Niheet's school from Esdoorn to Sint-Jozef").

### "What do you know about me?"

Call `list_profile_facts` (and optionally `get_historical_facts`) then respond with a grouped natural-language summary by subject (user, then each family member).

---

## Section 3: MCP Tools

Four new tools:

### `upsert_profile_fact`
Add a new fact or update an existing one. Handles all confidence arithmetic internally.

**Args:** `subject` (TEXT), `predicate` (TEXT), `value` (TEXT), `source` (`agent_inferred` | `user_stated`)

**Behaviour:**
- If no existing fact with same `subject` + `predicate` + `value` → insert
- If same `subject` + `predicate` + `value` exists → corroborate (confidence up, observed_count++)
- If same `subject` + `predicate` but different `value` → apply contradiction logic

### `correct_profile_fact`
Mark an existing fact as historical and save the corrected value at full confidence.

**Args:** `subject` (TEXT), `predicate` (TEXT), `old_value` (TEXT), `new_value` (TEXT)

### `get_historical_facts`
Return `is_historical = true` facts.

**Args:** `subject` (TEXT, optional — omit for all subjects)

### `list_profile_facts`
Return all current facts (`is_historical = false`, `confidence ≥ 0.6`) for a subject with confidence scores.

**Args:** `subject` (TEXT, optional)

### `get_profile_context` (existing — updated)
- Summarises current facts as natural language, grouped by subject
- New optional arg: `include_historical: true` — also returns past facts with a "used to" prefix

---

## Section 4: Agent Instructions (CLAUDE.md + plannen skill)

Add a **Profile building** section to both `CLAUDE.md` and `.claude/commands/plannen.md`:

```
## Profile building

During every conversation, passively extract profile facts about the user and their family members.

- Call `upsert_profile_fact` silently (no user-facing message) when you detect a new or corroborating fact.
- Save at most one fact per conversation turn.
- If the user corrects something, call `correct_profile_fact` silently.
- If the user asks "what do you know about me?", call `list_profile_facts` and respond with a natural-language summary grouped by subject.
- Use `get_profile_context` at the start of every session to prime yourself with what is already known.
```

---

## What is not in scope

- Web/mobile chat interface (future)
- Proactive profile suggestions in UI (future)
- Sharing profile facts between users (never — strictly private)
- Automatic confidence decay over time without new evidence (future — low priority)
