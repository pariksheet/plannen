---
description: Show the last few /plannen-mailbox-sync runs — when they ran, what they did, any errors.
---

The user has invoked `/plannen-mailbox-status`.

1. Read the last ~200 lines of `~/.plannen/logs/mailbox-sync.log` via the Bash tool.
2. Parse out the JSON report lines (one per run).
3. Show the last 5 runs as a table:

```
When                  ok  +created  ~updated  -cancelled  skipped  muted  gcal
2026-05-22 17:00      ✓   2         0          0           41       1      2
2026-05-22 16:00      ✓   0         0          0           18       0      0
2026-05-22 15:00      ✗   —         —          —           —        —      —     gmail.list_unprocessed: 503
```

4. If the log file is missing or empty, say *"No runs logged yet — has `npx plannen mailbox install` been run?"*.
