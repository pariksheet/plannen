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

### 2. Past-tense done → todo + complete

Trigger: a concrete action reported as finished ("finished cleaning the parking", "called the dentist", "kids are in bed").

```
create_event({ title, start_date: <now ISO>, event_kind: 'todo' })   → returns { id }
complete_todo({ id })                                                  // defaults completed_at to now
```

Receipt: `✓ Logged + done "<title>" · undo?`

### 3. Matches an active routine → mark practice done

Trigger: a short activity word that names a known recurring practice ("log gym", "did my vitamins", "dishes done").

```
list_practices({ active_only: true })   // if practices aren't already in this turn's context
// find the practice whose name matches the activity
mark_practice_done({ practice_id })     // completed_on defaults to today; idempotent
```

If the practice belongs to a circle member, pass `family_member_id`.

Receipt: `✓ Marked "<practice name>" done · today · undo?`

**No matching practice?** Fall through to case 2 — create a completed todo stamped now. **Never auto-create a practice/routine from `/log`** — that is a heavier, gated action. Creating routines stays in `plannen-day-plan`.

### 4. Person / place / attribute → profile fact

Trigger: a durable fact about a person, place, schedule, or preference ("met person A, lives on my street", "Milo started swimming on Tuesdays").

```
upsert_profile_fact({ subject, predicate, value, source: 'user_stated' })
```

Use the family member's UUID as `subject` for facts about a member; `'user'` for the user. Pick a **specific predicate** per item (`lives_on_street`, `swimming_class`) — never reuse one predicate for multiple distinct items (see the predicate rule in `plannen-core`). Use `source: 'agent_inferred'` only when you concluded it rather than were told.

Receipt (this one **is** shown — unlike plannen-core's silent passive capture, because the user explicitly logged it): `✓ Noted: <fact in plain words> · undo?`

### 5. Activity / time-block → not yet wired (Phase 2)

Trigger: an activity with a duration and no calendar slot ("slept 8h last night", "ran for 40 minutes", "deep work 2 hours this morning").

There is no `activity_logs` table yet. Do **not** mis-file it as a todo or a practice. Reply with the graceful notice and write nothing:

`⏳ Sleep/duration logging isn't wired up yet — coming soon. (Tell me if you'd rather I save it as a plain todo for now.)`

## Tie-breakers

- Past-tense / completion words ("finished", "did", "done", "just …ed") → case 2 or 3.
- A specific future time/date → case 1.
- "met / lives / works / allergic / prefers / their …" → case 4.
- Duration + activity, no clock slot ("8h", "40 minutes") → case 5.
- "log gym" — practice exists → case 3; no practice → case 2.

## Undo

Remember the last action you took this turn. On "undo" (or "no, scrap that"), reverse it with the inverse tool — no new infrastructure:

- future todo (case 1) → delete the event (set `event_status: 'cancelled'` via `update_event`, or note it's removed).
- done todo (case 2) → `uncomplete_todo({ id })`, then cancel the event as above.
- practice completion (case 3) → `unmark_practice_done({ practice_id, completed_on })`.
- profile fact (case 4) → `correct_profile_fact` to mark it historical.

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
