---
name: plannen-sources
description: Use when the user explicitly says "analyse my sources", "tag my sources", or asks to bulk-process saved event sources. Drives the manual variant of source analysis (the auto-trigger after create_event lives in plannen-core). Indexes each unanalysed source with name, descriptive tags, and source_type.
---

# Plannen — manual source analysis

The auto-trigger after `create_event` is in `plannen-core`. This skill is the **manual** variant — invoked when the user says "analyse my sources" or asks to bulk-process saved sources.

> For single-link saves mid-conversation (explicit, positive-intent, or end-of-discovery batch), see the "Saving sources (bookmarks)" section in `plannen-core.md`. This skill is the *bulk-analyse* manual path.

## Workflow

1. **Call `get_unanalysed_sources`** to fetch the queue of sources without `last_analysed_at`.

2. **For each source**, fetch `source_url` via WebFetch. Read the page to understand what kinds of events the organiser or platform publishes.

3. **Call `update_source`** with:
   - `id`: the source UUID
   - `name`: organiser or platform name (from page title or about section)
   - `tags`: up to 10 descriptive tags. **Always lead with the specific activity extracted from the page** (e.g. `horseriding`, `inline-skating`, `windsurfing`, `football`, `kayaking`) — never use `sports` as a substitute when the actual activity is clear. Then add from: other activity types (`camp`, `workshop`, `sailing`, `climbing`, `music`, `hiking`, `yoga`, `theatre`), audience (`kids`, `adults`, `family`, `teens`), geography (lowercase country/city — `belgium`, `brussels`), cadence (`annual`, `seasonal`, `recurring`), format (`residential`, `daytrip`, `online`, `weekend`). Pick the most discriminating ones.
   - `source_type`:
     - `platform` — lists many unrelated events (Eventbrite, Meetup)
     - `organiser` — single entity with recurring programmes (sports club, school)
     - `one_off` — a single event's own page

4. **Report.** Summarise: how many sources analysed, how many failed (with reasons). One line per source: name + top tags.

## Notes

- If `WebFetch` fails (404, redirect loop, paywall), skip that source and note it in the summary. Don't update the source — leaving `last_analysed_at` null lets the user retry.
- If a source page is in a non-English language, tag in English. The user's interface is English; tags are search-keys, not display text.
