---
name: kitchen-pantry
description: Use when the user asks what's in the pantry, what they bought recently, what's still around from last week's shop, or any "do I have X?" question. Reads kitchen.pantry via list_pantry.
---

# Kitchen — pantry queries

The pantry is a derived view over recently-picked items in `kitchen.items`. There is no separate inventory table — `list_pantry(days)` returns items picked within the last N days.

## "What's in the pantry?"

1. Call `list_pantry(days=14)` by default. Tighten to `days=7` if the user asks about the current week specifically; widen to `days=30` if they ask about "this month".
2. Group results by `store_name` for readability (most users think "what's in the fridge" rather than "what came from Carrefour", but grouping by store helps when they want to verify a particular shop).
3. Mention items more than ~5 days old explicitly — they may have been consumed already (we don't track consumption).

## "Do we still have X?"

1. Call `list_pantry(days=14)` and scan for the item name (case-insensitive).
2. If found: report when it was bought ("you picked up milk 2 days ago").
3. If not found: say so plainly. Don't speculate about whether they ate it — just report what the data shows.

## Caveats to surface

Pantry is "what you bought" not "what you have." If the user is making a decision based on it, mention this once at the start of the conversation so they know to verify perishables themselves. Don't repeat the caveat every message.

## When to suggest writing it back

If the user finds an error ("I never bought that paneer"), they probably tapped wrong in the UI. Offer to undo: call `update_item(item_id, status='pending')` (which, in v1, is via passing status through update_item — if `update_item` doesn't expose status, just leave it and tell the user to ignore the item).

## Boundaries

- Pantry queries are read-only. Don't add or remove items in this flow.
- Meal planning is `kitchen-meal-plan`, not here. If the user pivots from "what do we have" to "what should we cook", switch skills.
