# Event Memories — Claude-driven photo discovery

**Date:** 2026-05-07
**Tier:** 1
**Status:** Approved

## Goal

Let Claude (Code or Desktop) scan the user's Google Photos library, identify photos taken during a past event's time window, and attach them to the event — without the user manually picking each one through the existing web-app picker.

Photos attached this way render in the existing UI for free via the `memory-image` Edge Function. The web-app picker stays untouched as the user-facing fallback.

## Architecture

```
┌─────────────────┐                    ┌──────────────────────┐
│ Claude Code /   │  search_media_     │  google-photos-mcp   │
│ Claude Desktop  │  by_filter,        │  (local, npm)        │──→ Google Photos API
│                 │  get_photo         │  - 19 tools          │
│                 │ ───────────────────│  - own OAuth         │
│                 │                    │  - keychain tokens   │
│                 │  add_event_memory  └──────────────────────┘
│                 │ ─┐
└─────────────────┘  │                 ┌──────────────────────┐
                     └────────────────→│  plannen MCP         │
                                       │  + new tool          │──→ Supabase
                                       │  add_event_memory    │    event_memories
                                       └──────────────────────┘
```

**Three pieces:**

1. **`savethepolarbears/google-photos-mcp`** — third-party MCP server, npm-installed, runs locally in STDIO mode under Claude Desktop / Claude Code. Has its own Google OAuth flow (separate from the web app's). Provides `search_media_by_filter`, `get_photo`, and 17 other tools.

2. **plannen MCP — new `add_event_memory` tool.** Single thin writer. ~30 lines.

3. **CLAUDE.md — new "Photo organisation" section.** Instructs Claude when and how to invoke the workflow.

**No new schema (only one unique index).** The existing `event_memories` table already has `source` and `external_id` columns from migration `016`. The web app's `MemoryImage` component already proxies `external_id` through the `memory-image` Edge Function for rendering.

**No Google Photos data persisted.** We store only `external_id`. Metadata (timestamps, GPS) lives in Google Photos and is queried on-demand at scan time.

## Workflow

### Trigger

Explicit user request only — never proactive in tier-1.

- **Per-event:** *"find photos for the kayaking session"* / *"organise photos for last Sunday's event"*
- **Batch:** *"find photos for my events from May"* / *"organise photos for last weekend"*

Both shapes supported.

### Steps Claude follows

**1. Resolve target events.** Call `list_events` with appropriate `from_date` / `to_date` / `status` filter. Status is typically `past` or `going` for events that have already occurred. For each candidate event, fetch existing memories via `get_event` and collect `external_id`s where `source='google_photos'` to skip later.

**2. Compute time window per event.**

| Event shape | Window |
|---|---|
| Has `start_date` and `end_date` | `start − 15% of duration` to `end + 15% of duration` |
| Has `start_date` only | `±15 minutes` (assume 2-hour duration) |
| All-day (`00:00:00`) | Single calendar day, no buffer |

**3. Search Google Photos.** Call `search_media_by_filter` from `google-photos-mcp` with the window. Filter out anything in the per-event skip list.

**4. Vision triage on contact sheets.**

- Group candidate photos into batches of 9.
- For each batch, request thumbnails via `get_photo` and arrange as a 3×3 contact sheet for a single vision call.
- Claude classifies each photo as **match** / **no match** / **uncertain** based on event title, description, and visible content.
- **Optimisation:** if the candidate count for an event is ≤ 3, skip vision entirely and auto-add all candidates. With so few photos in the window, false positives are rare and the token saving is meaningful.

**5. Attach.**

- Vision-classified **match** → auto-add via `add_event_memory(event_id, external_id, source='google_photos')`.
- Vision-classified **uncertain** → list with one-line description, ask the user before adding.
- Vision-classified **no match** → skip silently.

**6. Report.** One line per event:

> *"Kayaking Beginners – Session 1: added 5 matches. 2 uncertain — want me to add them?*
> *  • photo of children near a parked car (could be drop-off?)*
> *  • indoor shot of food on a plate (looks like lunch, not kayaking)"*

### Re-runs

Re-running the same scan is **idempotent** — already-attached photos are filtered out by the skip-list step plus a DB-level unique index.

If the user manually deleted a photo in the UI and re-runs the scan, it **will** be re-added. Tier-1 limitation; conversation-local "skip these" memory is the workaround. A `rejected_external_ids` persistence layer is deferred to tier-2.

## New MCP tool: `add_event_memory`

**Location:** `mcp/src/index.ts`

**Signature:**

```ts
{
  name: 'add_event_memory',
  description: 'Attach a photo from an external source (Google Photos, Google Drive) to an event. Use after scanning Google Photos for an event\'s date range and identifying matches. Idempotent — duplicate (event_id, external_id) is silently ignored.',
  inputSchema: {
    type: 'object',
    properties: {
      event_id:    { type: 'string', description: 'Event UUID' },
      external_id: { type: 'string', description: 'Google Photos mediaItem id (or Drive file id)' },
      source:      { type: 'string', enum: ['google_photos', 'google_drive'], description: 'Provider; defaults to google_photos' },
      caption:     { type: 'string', description: 'Optional caption' }
    },
    required: ['event_id', 'external_id']
  }
}
```

**Implementation sketch:**

```ts
async function addEventMemory({ event_id, external_id, source = 'google_photos', caption }) {
  const supabase = await getUserClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('event_memories')
    .upsert(
      {
        event_id,
        user_id: user.id,
        photo_url: null,
        source,
        external_id,
        caption: caption ?? null,
      },
      { onConflict: 'event_id,external_id', ignoreDuplicates: true }
    )
    .select()
    .single()

  if (error) throw new Error(error.message)
  return { id: data?.id, attached: !!data }
}
```

**Doesn't:** fetch photo bytes (Edge Function handles that); write to Google Photos; rank or filter (Claude decides).

## Schema migration

One small migration — a unique index that backstops the upsert's `onConflict`:

```sql
-- supabase/migrations/<timestamp>_event_memories_external_id_unique.sql
CREATE UNIQUE INDEX IF NOT EXISTS event_memories_event_external_uniq
  ON public.event_memories (event_id, external_id)
  WHERE external_id IS NOT NULL;
```

No new columns. No data migration. Backup before applying per the project's migration discipline (`bash scripts/export-seed.sh`).

## CLAUDE.md additions

A new section below "Discovery queries":

````markdown
## Photo organisation

The user has `google-photos-mcp` installed. When the user asks to "find photos", "organise photos", or "add photos" for events, run the workflow below. **Do not run it proactively** — only on explicit request.

### Resolving the scope

- Per-event request → `list_events` to find recent past events matching the title.
- Batch by date range → `list_events` with `from_date` / `to_date` and `status='past'` (also include `going` for events that just occurred).

### Per event — scan and attach

1. **Skip list.** Call `get_event` and collect existing `external_id`s where `source='google_photos'`.

2. **Compute window:**
   - `start_date` and `end_date` → ±15% of duration around each end
   - `start_date` only → ±15 minutes
   - All-day (time is `00:00:00`) → single calendar day, no buffer

3. **Search.** Call `search_media_by_filter` from `google-photos-mcp` with the window. Drop anything in the skip list.

4. **Vision triage.**
   - If ≤ 3 candidates → auto-add all (skip vision).
   - Otherwise: request thumbnails via `get_photo` and assemble 3×3 contact sheets (9 per vision call). Classify each as match / no-match / uncertain based on the event title, description, and visible content.

5. **Attach.** Call `add_event_memory(event_id, external_id, source='google_photos')` for each match. List uncertain ones to the user with one-line descriptions and ask before adding.

6. **Report.** One line per event: title, count added, count uncertain. List uncertain photos with their descriptions.

### Re-runs

Re-running is idempotent — already-attached photos are skipped. Manually deleted photos **will** be re-added unless the user tells you to skip them in the same conversation. There is no persistent rejection list in tier-1.
````

## Setup — README addition

Add to project README:

```markdown
## Optional: Google Photos via Claude

For Claude-driven photo organisation, install `google-photos-mcp`:

    npm install -g google-photos-mcp

Configure it in your Claude Desktop / Claude Code MCP settings (see [savethepolarbears/google-photos-mcp](https://github.com/savethepolarbears/google-photos-mcp) for setup). Authenticate once via the local browser flow — tokens are stored in your OS keychain.

Then ask Claude things like *"organise photos for last weekend's events"*.
```

## Out of scope (tier-1)

| Item | Why deferred |
|---|---|
| Proactive scanning at session start | Explicit-only first; revisit once we know usage patterns |
| AI-generated captions | Adds vision cost; tier-2 |
| Lightbox / gallery UX redesign | Existing grid in `EventMemory.tsx` is sufficient |
| Multi-user shared memories | Single-user app today |
| Persistent rejection list (skip re-adding deleted photos) | Conversation-local memory only in tier-1 |
| `taken_at` / GPS columns on `event_memories` | Metadata lives in Google Photos; query at scan time |
| Location-based matching (GPS within 500 m) | Time-based only is enough; revisit if false-positive rate is bad |

## Implementation checklist

1. Migration: unique index on `(event_id, external_id)`.
2. plannen MCP: add `add_event_memory` tool (~30 lines + dispatcher entry).
3. CLAUDE.md: append "Photo organisation" section.
4. README: append "Google Photos via Claude" section.
5. Manual test: `google-photos-mcp` installed, authenticated, run a scan against a real past event with photos in the window.
