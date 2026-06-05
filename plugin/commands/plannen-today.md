---
description: Compose today's circle-aware day plan (events + practices + family context) and persist it.
argument-hint: "[date — optional, e.g. 'tomorrow' or '2026-05-22']"
---

The user has invoked `/plannen-today` with arguments: `$ARGUMENTS`.

Trigger the `plannen-day-plan` skill and follow its workflow exactly. If `$ARGUMENTS` is empty or "today", resolve to today's date. If it names a relative date ("tomorrow", "Friday", "next Monday") or an ISO date, resolve to that date and pass it to `get_briefing_context`.

Do not ask for additional input — this command is meant for a one-shot morning briefing. Compose, save, and return the markdown.
