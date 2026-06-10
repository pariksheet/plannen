---
description: Quick-capture journal — log a finished chore, a completed routine, a future todo, or who you met, and file it in the right place without ceremony.
argument-hint: "[what happened — e.g. 'finished cleaning the parking' or 'call dentist at 1pm']"
---

The user has invoked `/plannen-log` (aka `/log`) with arguments: `$ARGUMENTS`.

Trigger the `plannen-log` skill and follow its workflow exactly. Classify `$ARGUMENTS` into one routing case, take the action immediately (do **not** ask "want me to save this?" — `/log` bypasses the event-creation intent gate), and return a single-line receipt ending in `undo?`.

If `$ARGUMENTS` is empty, ask one short line: "What do you want to log?" — then stop. Otherwise act in one shot.
