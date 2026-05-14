---
name: kitchen-meal-plan
description: Use when the user asks to plan meals for the week, suggest dinners, decide what to cook, or asks any forward-looking question about meals. Combines kitchen.pantry contents with the Plannen calendar (school days, trips, parties) to suggest meals.
---

# Kitchen — meal-plan reasoning

There is no `suggest_meals` MCP tool. Meal planning is **your** reasoning over two data sources:

1. **Pantry:** call `list_pantry(days=14)` — what's recently bought.
2. **Calendar:** call `mcp__plannen__list_events(from_date=<today>, to_date=<today+7d>, limit=50)` — school days, trips, parties, anything that affects whether a meal needs to be cooked at home.

The `limit=50` is important: Plannen's `list_events` defaults to 10 and silently truncates. Always set 50 or higher for any week-or-longer planning question.

## The reasoning pattern

For a "plan dinners this week" request:

1. Determine which days need cooked meals at home. Skip days where an event implies "not eating at home" (e.g. a party from 7pm onward, a trip starting that day, a planned restaurant outing).
2. List the pantry items grouped by category in your head (proteins, vegetables, staples).
3. Suggest one meal per cooked-at-home day. Each meal should use at least one pantry item. Prefer meals that use multiple to reduce waste.
4. Note any gaps: ingredients the user needs to buy to complete suggested meals. Offer to add them to the active list (via the `kitchen-shop` skill — `list_lists(status='active', limit=1)` then `add_item`).

## Family context

The user's family (call `mcp__plannen__list_family_members()` if you don't already have it cached this session) likely includes kids in school. School days = lunchbox prep. School holidays = lunch at home. Factor that in when the user asks about lunches not just dinners.

## Output shape

Concise table or bullet list:

```
Mon: palak paneer (uses spinach + paneer from pantry)
Tue: rice + dal (staples only — no shopping needed)
Wed: skip — Sofie's birthday dinner
Thu: chicken curry (need: chicken, onions; rest in pantry)
Fri–Sun: trip to Pune — skip
```

Then a single line: "Add chicken + onions to this week's list?"

## What NOT to do

- Don't propose meals that ignore the calendar. If Wed is a party, don't suggest a Wed dinner.
- Don't make up pantry items. Only suggest what came back from `list_pantry`.
- Don't add ingredients to the list without explicit consent. Always confirm first.
- Don't store the meal plan anywhere. It's ephemeral — re-derive it each time.
