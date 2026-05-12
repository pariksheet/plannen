# Profile-extraction trigger broadening

**Date:** 2026-05-07
**Type:** Behavioral rule (CLAUDE.md edit)
**Status:** Design approved
**Supersedes (in part):** `2026-05-07-profile-building-design.md` (earlier trigger)

## Problem

Profile-fact extraction is silently failing during brainstorming sessions. In a recent multi-turn planning conversation about a Black Forest trip, the user revealed at least 9 durable facts:

- Drives a rented Peugeot E-3008 (full electric)
- Will receive an Xpeng G9 at end of May 2026
- Comfortable EV range ~200km; risk-averse about charging on highways with kids
- Niheet's school day ends Wednesday at 12:00
- Irshika attends a creche
- Travel-planning style: accommodation first, then activities
- Pool not a priority when traveling for activities
- Prefers apartment/studio over hotel
- Nimisha (wife) has a friend in Stuttgart
- Niheet wants to try tobogganing

`profile_facts` is empty after that session. None of these were saved.

The root cause is the trigger condition in `CLAUDE.md > Profile building`:

> After any MCP tool call that creates or updates an event, check if the conversation revealed a new or corroborating fact...

This collides with the new **Event creation: intent gate** (added the same day): brainstorming explicitly does **not** call event tools. So fact-extraction is gated on something that is, by design, suppressed during the most fact-rich portion of conversation.

The secondary issue is the **one-fact-per-turn cap**. Several real turns reveal multiple durable facts at once (e.g. *"school ends Wed 12pm and I pick Irshika from creche at 12pm"*). The cap silently drops the runners-up.

## Decision

Rewrite the **Profile building** section in `CLAUDE.md` with three changes:

1. **Trigger:** run extraction after every user message, independent of any event tool call.
2. **Cap:** remove the per-turn cap. Confidence threshold (≥0.6, system-enforced) and the new durability filter act as the throttle.
3. **Durability filter:** explicit inclusion/exclusion list — save stable attributes, schedules, preferences, relationships, characteristics; skip trip-ephemeral intent and conversational filler. Heuristic: would the fact still be useful in 30+ days?

## Rule text (verbatim into CLAUDE.md, replacing the existing Profile building section)

```markdown
## Profile building

At the start of every session, call `get_profile_context` (no args) to prime yourself with what is already known about the user and family members.

**Passive extraction — runs after every user message:**

- After every user message, check whether it revealed a durable fact about the user, a family member, or the household. If yes, call `upsert_profile_fact` **silently** (no user-facing message) before responding. Do **not** gate this on whether you also called an event tool — extraction runs independently.
- Save every durable, high-confidence fact in the message — there is no per-turn cap. The confidence threshold (≥0.6) and the durability filter below act as the throttle.
- Use the family member's UUID (returned by `get_profile_context` in `family_members[].id`) as the `subject` when saving facts about a family member.

**Durability filter — what counts as a fact worth saving:**

- ✅ **Save:** stable attributes ("drives a Peugeot E-3008"), schedules ("Niheet's school day ends Wednesday 12:00"), preferences ("prefers apartments over hotels", "won't risk highways with kids below 200km charge"), relationships ("Nimisha has a friend in Stuttgart"), characteristics ("Niheet wants to try tobogganing").
- ❌ **Skip:** trip-ephemeral intent ("we want to leave at 1pm next Wednesday"), in-flight planning decisions ("considering Stuttgart for night 1"), conversational filler ("yes that sounds good"). If the fact wouldn't still be useful in 30+ days, don't save it.

**Corrections and queries:**

- If the user says something that contradicts a known fact, call `correct_profile_fact` silently. Only surface the correction if it is significant (e.g. "I've updated Niheet's school from Esdoorn to Sint-Jozef").
- If the user asks "what do you know about me?" or similar, call `list_profile_facts` and respond with a natural-language summary grouped by subject (user first, then each family member by name).

**Extraction examples — typical sources of facts:**

- Family routines: "drop Niheet at Esdoorn", "Irshika at creche until 12pm"
- Preferences and dislikes: "I prefer mornings", "pool not required when traveling for activities"
- Possessions and resources: "I have an electric car", "rented Peugeot 3008"
- Recurring locations: "our usual spot", "pool in Hombeek"
- Interests and characteristics: "Niheet is really into football lately"
- Relationships: "Nimisha's friend lives in Stuttgart"
```

## Backfill

Concurrently with the rule change, save the 9 facts identified above via `upsert_profile_fact`. These are user-stated facts from a real conversation that the old trigger missed.

## Loose end

The `upsert_profile_fact` tool description in `mcp/src/index.ts` still says *"At most one call per conversation turn"*. After this change that guidance is wrong. Out of scope for this spec — flag for a follow-up MCP edit.

## Non-goals

- Tightening confidence scoring. Out of scope.
- Adding UI surface for reviewing/editing facts. Out of scope.
- Auto-promoting ephemeral facts to durable based on repetition. Out of scope.

## Success criteria

After this rule, a brainstorming-style conversation that reveals N durable facts produces N silent `upsert_profile_fact` calls. The Black Forest conversation transcript would yield ~9 facts saved.
