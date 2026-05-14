---
description: Paste this week's grocery list (text or image) and have Claude parse it into the kitchen.lists / kitchen.items tables.
argument-hint: "[paste list contents]"
---

The user has invoked `/kitchen-list`. Trigger the `kitchen-shop` skill.

If the user attached the list content as an argument, parse it immediately following the "When the user pastes a list" flow in `kitchen-shop`. If no content is attached, ask: *"Paste the list (text or an image of the handwritten list) and I'll add it to this week's list."*
