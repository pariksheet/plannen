# Create-event intent gate

**Date:** 2026-05-07
**Type:** Behavioral rule (CLAUDE.md addition)
**Status:** Design approved

## Problem

Claude calls `create_event` too eagerly when the user is still brainstorming. In a recent session the user said *"I am planning to go to Black Forest, Germany during 13–16 May with family"* and Claude immediately created a `going` event. The user had to interrupt with "no, I'm just trying to organise it for now". Claude then marked the event `cancelled` (the API has no hard delete), leaving residue in the database.

The root cause is in Claude's behaviour, not the schema. Exploratory phrasing ("I'm planning", "thinking about") is being read as commitment.

## Decision

Add a new section to `CLAUDE.md` titled **"Event creation: intent gate"**, positioned between *Profile building* and *Discovery queries*. The rule biases conservatively: default to brainstorming unless the user is explicitly imperative or supplies concrete scheduling details.

## Rule text (to be inserted verbatim into CLAUDE.md)

```markdown
## Event creation: intent gate

Before calling `create_event`, check whether the user has actually committed.

**Default to brainstorming** (do not create, ask first) unless the phrasing is explicitly imperative or carries concrete scheduling details.

**Brainstorming signals — ask first:**
- Exploratory verbs: "I'm planning to / thinking about / considering / looking at / want to / would like to / we might / we could / we should"
- Open-ended help requests: "find me", "help me organise", "what about", "any ideas for"
- Multi-day trips, fuzzy dates, no confirmed venue

**Commit signals — call `create_event` directly:**
- Imperatives: "save this", "add it", "book", "create the event"
- Concrete scheduling: confirmed date + place ("dentist Tuesday 14 May 9am at Sint-Jozef")
- Explicit "yes" in response to a "want me to save this?" prompt

**When unsure**, end the reply with: *"Want me to save this as a planned event, or are you still working it out?"* — then wait. Do not pre-emptively create and apologise after.
```

## Why behavioural, not schematic

Considered alternatives:

- **Hard `delete_event` tool** — addresses residue but not the root cause; still leaves users to clean up after Claude's mistakes.
- **`draft`/`proposed` event status** — would require UI surface area for "tentative" events and a state machine. Real engineering for a problem that can be solved by Claude asking one extra question.
- **No change, fix behaviour via instructions (this design)** — zero schema change, no UI work. The rare residual `cancelled` event from a misread is acceptable.

## Edge cases

- *"I want to take Niheet to a chess club"* → brainstorming. "I want to" is exploratory in this user's mental model. Respond with options + the save prompt.
- *"Add a dentist appointment Tuesday at 9am"* → commit. Imperative verb. Time-of-day not required; imperative phrasing is the trigger.
- User replies "yes" to the save prompt → commit. Treat the prompt as the disambiguation step.

## Non-goals

- Adding `delete_event` to the MCP. Re-evaluate only if the rule fails to prevent accidental creates in practice.
- Adding a `draft` status. Same — revisit only if behaviour-only fix proves insufficient.
- Changing how `cancelled` events are surfaced in queries. Out of scope.

## Success criteria

After applying the rule, exploratory phrasing produces a clarifying question rather than a `create_event` call. Imperative phrasing still creates directly without unnecessary friction.
