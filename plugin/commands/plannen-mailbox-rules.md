---
description: List and delete your mailbox ignore rules — the single-sender mutes that /plannen-mailbox-sync respects.
---

The user has invoked `/plannen-mailbox-rules`.

1. Call `mcp__plugin_plannen_plannen__list_ignore_rules` (no args — show all adapters).
2. Render a numbered table:

```
#  Adapter  Sender                          Hits  Last hit       Created
1  gmail    information@mailers.acmebank.bank.in   12    2026-05-21     2026-05-10
2  gmail    google-pay-noreply@google.com           4    2026-05-22     2026-05-15
```

3. Ask: *"Delete any? Reply with numbers (e.g. `1, 2`) or `none`."*
4. On a numeric reply, call `mcp__plugin_plannen_plannen__delete_ignore_rule({id})` for each selected row, in parallel.
5. Confirm: *"Deleted N rule(s). The corresponding senders will be re-evaluated by the next sync run."*

If `list_ignore_rules` returns `[]`, say *"No ignore rules — every sender is currently in scope."* and stop.
