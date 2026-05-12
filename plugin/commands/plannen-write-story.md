---
description: Write a story for a Plannen event or date range — composes a 250-600 word narrative from event memories and photos.
argument-hint: "[event title or date range]"
---

The user has invoked `/plannen-write-story` with arguments: `$ARGUMENTS`.

Trigger the `plannen-stories` skill and follow its workflow exactly. If `$ARGUMENTS` is empty, ask the user which event or date range to write about. If the arguments name a single event, resolve via `list_events` then `get_event`. If they describe a date range (e.g. "April school holidays" or "2026-04-10 to 2026-04-20"), use `list_events({ from_date, to_date, limit: 50 })`.

Always pause to ask for input (highlights, mood, tone, anyone to spotlight) before composing — even if `$ARGUMENTS` looked complete. The only phrasings that skip this pause are *"just write it"*, *"no input, go ahead"*, or *"skip the questions"*.
