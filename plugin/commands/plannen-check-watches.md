---
description: Force-check Plannen watched events now, regardless of next_check schedule.
argument-hint: ""
---

The user has invoked `/plannen-check-watches`. Trigger the `plannen-watches` skill manually.

Call `get_watch_queue` (no args). For each returned watched event, run the per-event processing workflow in `plannen-watches`. If the queue is empty, say so explicitly: *"No watches due. Everything's up to date."*.

This is the manual variant of the auto-check that runs at session start. It will be supplemented (not replaced) by future cloud routines.
