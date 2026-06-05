---
name: plannen-day-plan
description: Use when the user asks for today's plan, morning briefing, day plan, "what's on today", "what's my day looking like", or runs /plannen-today. Drives the Plannen MCP tools get_briefing_context → save_daily_briefing to compose a circle-aware structured day briefing. Also handles practice completion logging when the user mentions doing a practice.
---

# Plannen — day plan

Use when the user invokes `/plannen-today` or asks anything like "today's plan", "morning briefing", "day plan", "what's on today", "what's my day looking like". Compose a **structured, non-prose** briefing using the Plannen MCP tools, then persist it.

## Workflow

1. **Resolve date.** Default = today (in user's local timezone). If the user names a specific date ("tomorrow", "Friday", "2026-05-22"), resolve that date.

2. **Fetch context.** Call `get_briefing_context({ date })`. This returns events today + tomorrow, recent past events, your circle (family_members surfaced as "circle"), practices due today with weekly remaining counts, and locations. One call — no follow-up MCP reads unless the user asks a question requiring extra data.

3. **Compose the briefing.** Output markdown with this structure (omit any section that is empty):

   ```markdown
   # <Weekday>, <D Mon>

   ## Schedule
   - HH:MM — Event title (annotation if useful, e.g. "you driving")

   ## Practices today
   - [ ] Practice name (N/M this week)   // for weekly_count
   - [ ] Practice name (daily)            // for daily
   - [ ] Practice name                    // for specific_days

   ## Circle
   - One-line items about your circle relevant to the day:
     school holiday window, partner away dates, overdue calls, etc.
   ```

   **Format rules:**
   - **Conflict check first.** Before rendering Schedule, run the time-conflict check from `plannen-core` (dedupe series parents, compare going/planned time ranges). Render any overlap as a `⚠️` line directly under the first affected event: `  ⚠️ overlaps <other event> HH:MM–HH:MM`.
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

## Anti-patterns

- **Don't** call `list_events` separately — `get_briefing_context` already includes today's and tomorrow's events.
- **Don't** add motivational copy, encouragement, or coaching prose. The user wants a sketch, not a coach.
- **Don't** propose time slots for practices. Scheduling is out of scope for v1.
- **Don't** invent practices. Only render what `practices_due_today` returns.
- **Don't** auto-mark completions. Only when the user explicitly says they did something.
