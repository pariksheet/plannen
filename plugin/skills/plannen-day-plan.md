---
name: plannen-day-plan
description: Use when the user asks for today's plan, morning briefing, day plan, "what's on today", "what's my day looking like", or runs /plannen-today. Drives the Plannen MCP tools get_briefing_context → save_daily_briefing to compose a circle-aware structured day briefing. Also handles practice completion logging when the user mentions doing a practice.
---

# Plannen — day plan

Use when the user invokes `/plannen-today` or asks anything like "today's plan", "morning briefing", "day plan", "what's on today", "what's my day looking like". Compose a **structured, non-prose** briefing using the Plannen MCP tools, then persist it.

## Workflow

1. **Resolve date.** Default = today (in user's local timezone). If the user names a specific date ("tomorrow", "Friday", "2026-05-22"), resolve that date.

2. **Fetch context.** Call `get_briefing_context({ date })`. This returns events today + tomorrow, recent past events, your circle (family_members surfaced as "circle"), practices due today with weekly remaining counts, and locations. It also returns:
   - `attendances_today` — a member's recurring enrolments active today (school, creche, camp), already resolved for blackout suppression and the member-overlap override. **Indicative only**: render as circle/context, never conflict-check them.
   - `obligations_today` — the resolved timed drop/pick tasks (already re-projected onto whichever attendance instance survived). **Actionable**: treat these like events — they go in Schedule and DO participate in the conflict check.
   - `overdue_todos` — open todos (`event_kind=todo`, not completed, not cancelled) whose due date fell in the last 30 days, oldest first. Render under a `## Overdue` section above Schedule.

   One call — no follow-up MCP reads unless the user asks a question requiring extra data.

3. **Compose the briefing.** Output markdown with this structure (omit any section that is empty):

   ```markdown
   # <Weekday>, <D Mon>

   ## Overdue
   - [ ] Todo title (due <D Mon>)        // overdue_todos, oldest first; omit section if none

   ## Schedule
   - HH:MM — Event title (annotation if useful, e.g. "you driving")
   - HH:MM — Drop Milo at example school   // obligations_today render here, timed like events

   ## Practices today
   - [ ] Practice name (N/M this week)   // flex_count → show remaining of target
   - [ ] Practice name (daily)            // pinned daily → label the cadence
   - [ ] Practice name                    // pinned on specific days → no count

   ## Circle
   - One-line items about your circle relevant to the day:
     school holiday window, partner away dates, overdue calls, etc.
   - Today's attendances (attendances_today) as context: "Milo at example school 08:30–15:30"
   ```

   **Format rules:**
   - **Conflict check first.** Before rendering Schedule, run the time-conflict check from `plannen-core` (dedupe series parents, compare going/planned time ranges). Render any overlap as a `⚠️` line directly under the first affected event: `  ⚠️ overlaps <other event> HH:MM–HH:MM`.
   - **Overdue.** Render `overdue_todos` as `[ ]` checkbox lines under `## Overdue` above Schedule, oldest first, each annotated `(due <D Mon>)` from its `start_date`. Omit the whole section when `overdue_todos` is empty. On overflow it ranks just below time-conflicted events.
   - **Bullets only**, no prose paragraphs, no motivational/coach copy.
   - Max ~30 lines total. If context overflows, prioritise: events with time conflicts > kids' events > partner's events > recurring reminders.
   - Practices: render `[ ]` when not yet done today, `[x]` if `completions_this_week` already includes today's date.
   - Times in 24h `HH:MM`.
   - Empty day: output a single line "Quiet day, no practices due." under `# <Weekday>, <D Mon>` and skip all sections.

4. **Persist.** Call `save_daily_briefing({ briefing_date, content_md, source })` with `source` matching the invocation surface:
   - `'claude_code'` when invoked from Claude Code
   - `'claude_desktop'` when invoked from Claude Desktop
   - `'web'` when invoked from a web client
   - `'cron'` when invoked by a scheduled job
   When in doubt, use `'claude_code'`.

5. **Handle completion mentions.** If, in the same turn or a follow-up, the user mentions doing a practice ("did gym", "took vitamins", "done with dishes"), call `mark_practice_done({ practice_id })` for each — resolve the practice by name from the context. Confirm with one short line: "Logged: gym, vitamins."

## Creating practices (recurrence model)

A **practice** is a recurring personal routine with no precise clock time (gym, meal prep, vitamins, dishes). When the user asks to add one, call `create_practice` and pick **one** of two recurrence modes:

- **`recurrence_mode: 'pinned'`** — fixed cadence on a calendar pattern. Set `recurrence_rule`:
  - `{ frequency: 'daily' }` — plain daily.
  - `{ frequency: 'daily', interval: 2 }` — every other day. `interval: N` = every N days; the cadence counts from `dtstart` if given.
  - `{ frequency: 'weekly', days: ['MO','TU','WE','TH','FR'] }` — weekdays.
  - `{ frequency: 'weekly', days: ['MO','WE','FR'] }` — specific days.
  - `{ frequency: 'monthly' }` — once a month.
  - Optional: `dtstart` (`YYYY-MM-DD` anchor) and `recurrence_until` (`YYYY-MM-DD` end date).
- **`recurrence_mode: 'flex_count'`** — "N times per period, any day". Set `flex_period: 'week' | 'month'` and `flex_target: 1..31`. No specific days.

Day codes are two-letter uppercase: `MO TU WE TH FR SA SU` (same as events). Practices also take a coarse `preferred_time_of_day`: `morning | afternoon | evening | anytime`.

**Examples** (generic personas only):

- "Milo and I meal-prep every other day" → pinned, `recurrence_rule: { frequency: 'daily', interval: 2 }`.
- "Take vitamins every weekday morning" → pinned, `recurrence_rule: { frequency: 'weekly', days: ['MO','TU','WE','TH','FR'] }`, `preferred_time_of_day: 'morning'`.
- "Gym 3× a week, whenever I can fit it" → flex_count, `flex_period: 'week'`, `flex_target: 3`.
- "Do the dishes Mon/Wed/Fri evenings" → pinned, `recurrence_rule: { frequency: 'weekly', days: ['MO','WE','FR'] }`, `preferred_time_of_day: 'evening'`.
- "Deep-clean the kitchen twice a month" → flex_count, `flex_period: 'month'`, `flex_target: 2` (or pinned `{ frequency: 'monthly' }` if it's a fixed once-a-month slot).

**A time-pinned routine is NOT a practice.** If it has a precise clock time tied to a place — a school drop-off at 08:15, a standing 17:00 pickup — create a **recurring event/attendance** (`create_event` with a `recurrence_rule`), not a practice. Practices only carry the coarse `preferred_time_of_day`, never `HH:MM`.

## Anti-patterns

- **Don't** call `list_events` separately — `get_briefing_context` already includes today's and tomorrow's events.
- **Don't** add motivational copy, encouragement, or coaching prose. The user wants a sketch, not a coach.
- **Don't** propose time slots for practices. Scheduling is out of scope for v1.
- **Don't** invent practices. Only render what `practices_due_today` returns.
- **Don't** auto-mark completions. Only when the user explicitly says they did something.
- **Don't** give a practice an `HH:MM` time. Anything with a precise clock time is a recurring event, not a practice.
