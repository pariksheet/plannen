---
description: Find and attach Google Photos to a Plannen event using the picker.
argument-hint: "[event title or description]"
---

The user has invoked `/plannen-organise-photos` with arguments: `$ARGUMENTS`.

Trigger the `plannen-photos` skill and follow its workflow exactly. If `$ARGUMENTS` is empty, ask the user which event. If the arguments describe a date or activity rather than naming an event, match against recent events via `list_events`. If no matching event exists, offer to create one first.

Surface the picker URI as a clickable link with clear instructions. Wait for the user to say they're done before polling.
