# Stories — Tier 1

**Date:** 2026-05-07
**Tier:** 1
**Status:** Approved

## Goal

Turn events (and groups of events) into shareable, AI-written narratives. The user can ask Claude (in Claude Code or Claude Desktop) to write a short story about a past event using its details and attached photos. Stories are saved, browseable in a dedicated **My Stories** tab, readable in a focused reader view, and editable by hand.

This branch ships the data model, the MCP tools that let Claude generate and persist stories, and the in-app browse + read + edit UI. The in-app **Generate** button (with its own loading UX) and sharing are deferred.

## Architecture

```
┌─────────────────┐                       ┌──────────────────────┐
│ Claude Code /   │  get_event,           │  plannen MCP         │
│ Claude Desktop  │  list_event_memories  │  - existing tools    │──→ Supabase
│ (the model      │ ─────────────────────→│  - new tools (6)     │    stories,
│  composes the   │                       └──────────────────────┘    story_events,
│  story itself)  │                                                   event_memories,
│                 │  fetch photo URLs                                 events
│                 │ ─────────────────────→ (web fetch, public URLs)
│                 │                          on event-photos bucket
│                 │  create_story
│                 │ ─────────────────────→ (writes row + links)
└─────────────────┘
                                          ┌──────────────────────┐
                                          │ Web app (React)      │
                                          │ - My Stories tab     │──→ Supabase (RLS)
                                          │ - Story reader       │
                                          │ - Inline section in  │
                                          │   event modal        │
                                          └──────────────────────┘
```

**Three layers:**

1. **Database** — new `stories` and `story_events` tables. Cover URL denormalised onto `stories` for cheap feed queries.
2. **MCP** — six new tools on the `plannen` server. Generation logic runs in the model (Claude Code / Desktop), not in an edge function.
3. **Web app** — new top-level `My Stories` tab, dedicated `StoryReader`, inline `EventStorySection` in the existing `EventDetailsModal`.

**Why no `agent-story` edge function.** `agent-discover` exists because the web app has an in-app Search UI that needs a server-side endpoint when the user isn't running Claude Code. Story generation in tier 1 is exclusively agent-driven through Claude Code / Desktop, so the model itself does the synthesis. An edge function only becomes necessary if/when an in-app **Generate** button is added (post-tier-1) — at that point the data layer doesn't change, only the trigger does.

## Scope

**In scope**

- New `stories` table + `story_events` join table (supports both event-bound and multi-event/date-range stories)
- New MCP tools: `list_event_memories`, `create_story`, `update_story`, `get_story`, `list_stories`, `delete_story`
- New top-level **My Stories** tab — hero card + 2-col grid feed
- New dedicated **StoryReader** view (cover, title, body, edit-in-place, change cover, delete)
- New inline **EventStorySection** in `EventDetailsModal`, below the existing memories section. Read-only preview when a story exists; muted empty state when none.
- RLS, migration, MCP and component tests, manual end-to-end verification

**Deferred (post-tier-1)**

- In-app **Generate Story** button + loading UX (skeleton vs streaming)
- The `agent-story` edge function (only needed once the in-app button exists)
- Sharing (copy text, share-as-image, social publishing)
- Re-evaluating in-event placement — user noted the inline-below-memories layout is "not the way I like" but acceptable for MVP

## Data model

### `stories`

```sql
CREATE TABLE public.stories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,                 -- markdown allowed
  cover_url     TEXT,                          -- nullable; resolved at render time if null
  user_notes    TEXT,                          -- optional reflection from the user
  mood          TEXT,                          -- e.g. "chill", "memorable" (chips are UI sugar)
  tone          TEXT,                          -- e.g. "diary", "postcard"
  date_from     DATE,                          -- nullable; only for date-range stories
  date_to       DATE,                          -- nullable; only for date-range stories
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at     TIMESTAMPTZ,                   -- set when user edits body or title
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stories_user_generated_idx ON public.stories (user_id, generated_at DESC);

-- Auto-stamp edited_at whenever the user changes title or body.
-- Fires from any write path (MCP handler or direct supabase client from the UI).
CREATE OR REPLACE FUNCTION public.set_stories_edited_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := NOW();
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stories_set_edited_at
  BEFORE UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.set_stories_edited_at();
```

### `story_events`

```sql
CREATE TABLE public.story_events (
  story_id  UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  event_id  UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, event_id)
);

CREATE INDEX story_events_event_idx ON public.story_events (event_id);
```

### Cardinality enforcement

One story per event for event-bound stories; multi-event stories are exempt. A simple partial unique index can't express "only when this event has exactly one row in `story_events`" because Postgres doesn't allow subselects in partial-index predicates. Enforced in the MCP `create_story` handler instead: if a single-event story already exists for the target event, the handler updates the existing row rather than inserting (overwrite semantics).

### RLS

- `stories`: `user_id = auth.uid()` for select, insert, update, delete.
- `story_events`: select/insert/update/delete only when the related `stories.user_id = auth.uid()`. Use a policy that joins on the FK.

### Why a join table (instead of `events.story_id` or `stories.event_id`)

- Multi-event stories from the agent need M:N — a single FK can't express it
- Cover URL is denormalised onto `stories.cover_url` so feed queries don't need to join through memories
- `event_memories` and other event-attached rows already follow the "child has FK to event" pattern, so a join table is the smallest deviation that supports the new feature

### Migration filename

`supabase/migrations/20260507000003_stories.sql` (continues the timestamped pattern used by the most recent migrations). Apply with `supabase migration up` after running `bash scripts/export-seed.sh` for backup.

## Generation backend (MCP-only for tier 1)

Generation is performed by Claude in Claude Code / Claude Desktop, calling MCP tools. There is no server-side generator.

**Flow when the user says "write a story for the Brussels Motor Show event":**

1. Call `get_event({ id })` for title, description, dates, location.
2. Call `list_event_memories({ event_id })` for `[{ id, photo_url, caption, taken_at, created_at }]`.
3. Sample images for vision: `n_vision = min(ceil(n_total / 2), 5)`. Pick evenly across the timeline by index `floor(i * n_total / n_vision)` for `i in 0..n_vision-1`. Fetch those URLs with web fetch so the model can actually see them.
4. Compose title + body using event metadata, the sampled images, and captions for the rest. The user's reflection / mood / tone come from their natural-language message.
5. Call `create_story({ event_ids, title, body, user_notes?, mood?, tone?, cover_url?, date_from?, date_to? })`. The handler writes the `stories` row, creates `story_events` link(s), and on conflict (single-event story already exists for that event) updates instead of inserting.

**Multi-event / date-range stories:** Same flow with `event_ids.length > 1` and optional `date_from` / `date_to`. Cover defaults to first memory across all linked events by `taken_at`.

**Token / image budget:**

- Up to 5 images via web fetch (the cap above)
- Captions truncated to 200 chars in context
- Output target: 2–4 paragraphs, ~250–600 words

## MCP tools

All six new tools live in the existing `plannen` MCP server. They return JSON identical in shape to existing plannen tools.

### `list_event_memories({ event_id }) → memories[]`

Returns the event's memories ordered by `taken_at ASC NULLS LAST, created_at ASC`. Existing `event_memories` columns: `id, event_id, photo_url, caption, taken_at, created_at, external_id, source`.

### `create_story({ event_ids, title, body, user_notes?, mood?, tone?, cover_url?, date_from?, date_to? }) → { id, overwritten }`

- Validates that every `event_ids` entry exists and belongs to the current user.
- If `event_ids.length === 1` and a story is already linked to that event, **update** that row's `title, body, user_notes, mood, tone, cover_url, generated_at` and return `{ id, overwritten: true }`.
- Otherwise insert a new `stories` row plus one `story_events` row per event, return `{ id, overwritten: false }`.
- Defaults `cover_url` to the first memory by `taken_at` across all linked events when not provided.

### `update_story({ id, title?, body?, cover_url? }) → story`

- Updates only the provided fields. The `stories_set_edited_at` trigger handles `edited_at` automatically (fires whenever title or body changes from any write path, including direct UI writes).
- Returns the full updated story including linked event summaries.

### `get_story({ id }) → { ...story, events: [{ id, title, start_date }] }`

Single story plus minimal info on linked events (for subtitle rendering in the reader).

### `list_stories({ limit?, offset? }) → stories[]`

Defaults to current user, ordered by `generated_at DESC`. Each row includes a small `events` array (id + title + start_date) so the feed can render subtitles without N+1 queries.

### `delete_story({ id }) → { success: true }`

Cascades `story_events` rows automatically.

## Frontend

### Top-level **My Stories** tab

- Add `'stories'` to the `View` type in `src/components/Navigation.tsx`. New tab between **My Plans** and **My Family**, icon: `BookOpen` (lucide).
- Register `/stories` route, render new page `src/components/MyStories.tsx`.

### `MyStories.tsx` — feed

- Fetches via new `useStories()` hook that calls `supabase.from('stories').select('*, story_events(event_id, events(id, title, start_date))')` ordered by `generated_at DESC`. Same shape pattern as `EventList`.
- Layout: most recent story = full-width hero card (21:9 cover, subtitle, title, opening 140 chars of body). Remaining stories = 2-col grid below (1-col on mobile). Grid card = 1:1 cover, title, date subtitle, no body preview.
- Subtitle rules:
  - Single linked event: `"<event title> · <formatted date>"`
  - Multiple linked events: `"<n> events · <date range>"`
  - No linked events but `date_from`/`date_to` set: `"<date range>"`
  - Orphan: `"Standalone story"`
- Click any card → opens the **StoryReader** at `/stories/:id`.
- Empty state: bookmark icon + "No stories yet. Ask the agent to write one for any past event."

### `StoryReader.tsx` — dedicated reader

- Route: `/stories/:id`. Loads via `useStory(id)`.
- Layout: full-width cover image (`max-h: 50vh, object-cover`), title (h1), subtitle (event names + dates), body rendered as paragraphs. If markdown parser already exists, use it; otherwise split on `\n\n` to `<p>` blocks.
- Header actions menu (right side): **Edit**, **Change cover**, **Delete**.
- **Edit mode**: title becomes a single-line input, body becomes a textarea sized to its current content. Save / Cancel buttons surface. Save calls Supabase `update`; the `stories_set_edited_at` trigger stamps `edited_at` automatically. No regenerate button (regeneration = ask the agent again).
- **Direct entry into edit mode**: opening `/stories/:id?edit=1` mounts the reader already in edit mode. Used by the inline event-modal "Edit" link.
- **Change cover**: small picker showing all `event_memories` photos for the linked events, ordered by `taken_at`. Click one → updates `stories.cover_url`. Already-attached memories only.
- **Delete**: confirm dialog, then `delete from stories where id = ...`. Navigate back to `/stories`.

### `EventStorySection.tsx` — inline section in `EventDetailsModal`

- New component rendered below `<EventMemoryComponent>` (currently `src/components/EventDetailsModal.tsx:158`).
- Two states:
  - **No story:** muted empty state — bookmark icon + "No story yet. Ask the agent to write one." No Generate button.
  - **Story exists:** card-style preview with cover thumb, title, opening 2 lines of body, "Read full" link → opens `/stories/:id` reader. Small "Edit" link opens `/stories/:id?edit=1` (reader mounts in edit mode).
- For multi-event stories that include this event: same preview with subtitle hint ("Part of '3 events · Mar 20–22'").

### Hooks

- `useStories()` — list + Supabase realtime subscription, current user's stories
- `useStory(id)` — single story with linked events
- `useEventStory(eventId)` — single-event story for the inline section, returns null when none

All read directly from Supabase. Writes (update title/body/cover, delete) use the supabase client. The MCP tools wrap the same SQL so behaviour stays consistent across UI and agent.

### Intentionally not in MVP

- No regenerate button in UI (ask the agent)
- No share button (deferred)
- No drafts / multiple stories per event

## Edge cases

- **Event has zero memories** — story generates from event metadata alone. Cover stays `NULL`; the feed and reader render a Tailwind gradient placeholder consistent with the app's existing event-card style.
- **Linked event deleted after story creation** — `story_events` row cascades away. Story stays. If all linked events are gone, story becomes orphan; subtitle uses `date_from`–`date_to` if set, else "Standalone story". Orphans still appear in My Stories.
- **`cover_url` becomes invalid** — `<img onError>` swaps in the gradient placeholder. Don't null out the column (user might re-upload).
- **Multi-event story spans multiple years** — subtitle uses the full date range (`Mar 2026 – Feb 2027`).
- **Body edited to empty** — block save at the form layer; required field. No DB constraint change.
- **Memories change after story creation** — body doesn't auto-update; `edited_at` reflects last manual edit only. Stories are point-in-time snapshots by design.

## Error handling

- `create_story` with invalid `event_ids` → 400, response lists which IDs failed validation.
- `create_story` for a single event that already has a story → upsert. Handler returns `{ overwritten: true }` so the agent can mention it ("I replaced the existing story").
- Supabase write failure in the UI editor → toast error, keep editor open with the user's unsaved changes intact.
- `list_event_memories` for an event that doesn't belong to the current user → 403.

## Testing

**Migrations.** Apply via `supabase migration up`. Per `CLAUDE.md`, never `supabase db reset`. Run `bash scripts/export-seed.sh` first as backup.

**Database / RLS tests** in `tests/`:

- A user can read/write only their own stories
- A user cannot insert a `story_events` row for another user's story
- Deleting an event cascades to `story_events` but not to `stories`
- Deleting a story cascades to `story_events`

**MCP handler tests** in `mcp/`:

- `create_story` with one event: inserts `stories` + 1 `story_events`
- `create_story` with one event when one already exists: updates, `overwritten: true`
- `create_story` with N events: inserts `stories` + N `story_events`
- `update_story` updates only provided fields and sets `edited_at` when title/body changed
- `delete_story` cascades
- `list_event_memories` returns ordered by `taken_at ASC NULLS LAST, created_at ASC`

**Component tests:**

- `MyStories` renders empty state, hero+grid layout, click → reader navigation
- `StoryReader` view → edit → save flow, change-cover picker, delete confirm
- `EventStorySection` renders both empty and populated states
- Subtitle formatting helper covers single / multi / range / orphan cases

**Manual verification** (per `CLAUDE.md` UI guidance):

1. Start the dev server. Open a past event with attached memories.
2. Ask the agent: "write a story for this event."
3. Confirm the story appears in the **My Stories** tab as the hero card.
4. Open the reader, edit body, save — confirm `edited_at` updates and changes persist.
5. Change cover from the picker — confirm new cover renders in feed and reader.
6. Ask the agent: "write a story covering my Stuttgart trip" (multi-event).
7. Confirm subtitle shows event count + date range.
8. Delete one of the linked events; confirm story stays with reduced subtitle.
9. Delete the story from the reader; confirm it disappears from the feed.

**Out of scope for tests**

- Generation quality (agent-driven; quality is verified by inspection)
- Sharing flows (deferred)

## Open questions

None — all questions from `backlog/stories.md` resolved during brainstorming:

- "Friends/family generate their own story for a shared event?" — N/A; this is a single-user app per project memory.
- "Story includes attendee names from RSVPs?" — Not in MVP. Future enhancement when shared events arrive.
- "Image-in-prompt: vision or describe?" — Hybrid sampling: ⌈50% of photos⌉ capped at 5 as vision, captions for the rest.
