---
name: plannen-log
description: Use when the user logs something into Plannen — runs /log or /plannen-log, says "log…", "note that…", "jot…", "record…", OR makes a clear past-tense report of something done ("finished the parking", "kids are in bed", "just met our new neighbour", "took my vitamins", "called the dentist"). Frictionless journal capture — act immediately, then print a one-line receipt with an undo hint. Do NOT use for questions, intentions, or hypotheticals.
---

# Plannen — log (frictionless journal)

This is the **capture** path. The user is telling you something to record — a finished chore, a completed routine, a future todo, or who they met. **Act immediately, then print a one-line receipt.** This skill is the one sanctioned exception to the event-creation intent gate in `plannen-core`: when logging, you do **not** ask "want me to save this?" — you file it and report.

## When this fires

1. `/log` or `/plannen-log` (explicit — always acts).
2. Logging lead-ins in chat: "log…", "note that…", "jot down…", "record…".
3. **Bare past-tense reports** of something done, with no keyword: "finished the parking", "kids are in bed", "just met our new neighbour", "took my vitamins".

## Guard rails — when NOT to act

The ambient trigger (#3) is the hazard. Act ONLY on **completed, concrete, first-person / household actions stated as fact**. Do **nothing** (reply normally, no write) when the message is:

- A **question**: "did you finish the parking?", "is gym done?"
- An **intention / hypothetical**: "I should finish the parking", "maybe I'll clean the garage later", "we might do the dishes tonight", "thinking about a gym session".
- **Narration about others** you can't action, or anything inside an active **brainstorm / planning** thread.

When a report is genuinely borderline, the journal default applies — act, because the receipt + one-word undo make a wrong guess cheap to reverse. But never act on a clear question or intention.

## Routing — classify into exactly one case, then act

### 1. Future / timed task → todo

Trigger: a thing to do with a future time or date ("call dentist at 1pm", "todo: renew passport Friday").

```
create_event({ title, start_date: <resolved ISO>, event_kind: 'todo' })
```

Do **not** complete it. `start_date` is timezone-naive in the user's profile TZ unless they give an offset.

Receipt: `✓ Todo "<title>" · <weekday/today> HH:MM · undo?`

### 2. Past-tense done → `log_completion` (server resolves it)

Trigger: a concrete action reported as finished ("just finished gym today", "finished cleaning the parking", "called the dentist", "kids are in bed").

**Call the single server-side tool — it does the three-tier resolution atomically so behaviour is identical on every surface (mobile included):**

```
log_completion({ title: "<the activity>", when?: <ISO if not now>, family_member_id?: <for a circle member> })
```

The tool resolves, first match wins, and tells you which path it took via `action`:

| `action` returned | What it did | Receipt |
|---|---|---|
| `completed_todo` | An existing **open todo** matched the title → completed *that* (no duplicate). | `✓ Done "<title>" · undo?` |
| `marked_practice` | An active **routine** matched the name → logged a completion. | `✓ Marked "<name>" done · today · undo?` |
| `logged_todo` | Neither matched → logged a **fresh completed todo**. | `✓ Logged + done "<title>" · undo?` |

Matching is **conservative** (a confident single match only) — so it never completes the wrong thing; when unsure it just logs a fresh completed todo, which is cheap to `undo`. **Never auto-create a practice/routine from `/log`** — that is a heavier, gated action that stays in `plannen-day-plan`.

Keep `title` short and matchable ("gym", "clean the parking") so the server can match an existing todo/routine. Pass `family_member_id` when the completion is for a circle member.

### 3. Person / place / attribute → profile fact

Trigger: a durable fact about a person, place, schedule, or preference ("met person A, lives on my street", "Milo started swimming on Tuesdays").

```
upsert_profile_fact({ subject, predicate, value, source: 'user_stated' })
```

Use the family member's UUID as `subject` for facts about a member; `'user'` for the user. Pick a **specific predicate** per item (`lives_on_street`, `swimming_class`) — never reuse one predicate for multiple distinct items (see the predicate rule in `plannen-core`). Use `source: 'agent_inferred'` only when you concluded it rather than were told.

Receipt (this one **is** shown — unlike plannen-core's silent passive capture, because the user explicitly logged it): `✓ Noted: <fact in plain words> · undo?`

### 4. Activity / time-block → not yet wired (Phase 2)

Trigger: an activity with a duration and no calendar slot ("slept 8h last night", "ran for 40 minutes", "deep work 2 hours this morning").

There is no `activity_logs` table yet. Do **not** mis-file it as a todo or a practice. Reply with the graceful notice and write nothing:

`⏳ Sleep/duration logging isn't wired up yet — coming soon. (Tell me if you'd rather I save it as a plain todo for now.)`

## Tie-breakers

- Past-tense / completion words ("finished", "did", "done", "just …ed") → case 2 (resolves existing-todo → practice → new-todo in that order).
- A specific future time/date → case 1.
- "met / lives / works / allergic / prefers / their …" → case 3.
- Duration + activity, no clock slot ("8h", "40 minutes") → case 4.
- "just finished gym": open `gym` todo exists → complete it; else gym practice exists → mark done; else log a new completed todo.

## Undo

Remember the last action you took this turn. On "undo" (or "no, scrap that"), reverse it with the inverse tool — no new infrastructure:

- new future todo (case 1) → delete the event (set `event_status: 'cancelled'` via `update_event`, or note it's removed).
- completed an **existing** todo (case 2 tier 1) → `uncomplete_todo({ id })` only — it pre-existed, so re-open it, don't delete it.
- logged a **new** completed todo (case 2 tier 3) → `uncomplete_todo({ id })`, then cancel the event as above.
- practice completion (case 2 tier 2) → `unmark_practice_done({ practice_id, completed_on })`.
- profile fact (case 3) → `correct_profile_fact` to mark it historical.

Confirm with one line: `✓ Undone.`

## Receipt rules

- **One line**, always ending in `undo?` (except case 5's "coming soon" notice and the undo confirmation).
- Format: `✓ <what happened> · <when/where if useful> · undo?`.
- 24h `HH:MM`. No prose, no encouragement, no coaching.
- One action per log. If the user logs several things in one message ("kids in bed, took vitamins"), classify and act on each, then print one receipt line per action.

## Anti-patterns

- **Don't** ask "want me to save this?" — logging bypasses the intent gate. That's the whole point.
- **Don't** act on questions, intentions, or hypotheticals (see Guard rails).
- **Don't** auto-create a practice/routine. No matching practice → completed todo.
- **Don't** mis-file an activity-with-duration as a todo. Use the case-5 notice.
- **Don't** capture profile facts silently here — `/log` shows a receipt so the user can undo.
- **Don't** add prose or motivational copy. A receipt is a receipt.
