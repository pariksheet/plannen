# Event Source Intelligence — Design Spec

## Goal

Every enrollment URL the user adds is a signal. Over time, the app builds a personal index of known sources — organisers, platforms, publishers — each tagged with up to 10 labels describing what they do, where they operate, and what kind of events they run. When the user searches or asks a discovery question, Claude queries this index first to fetch from trusted, relevant sources before doing a general web search.

## Architecture

Three layers:

1. **Data capture** — on event create, extract the domain from `enrollment_url` and upsert a bare `event_sources` record (no tags yet)
2. **Analysis** — Claude fetches the source homepage and assigns tags; triggered immediately after MCP-based event creation, or on demand ("analyse my sources")
3. **Discovery** — `search_sources` MCP tool lets Claude query the index by tags when answering user questions

No Edge Functions. Pure Supabase tables + MCP tools + Claude.

## Data layer

### `event_sources`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK, default `uuid_generate_v4()` |
| `user_id` | UUID FK | References `users` — ready for tier-4 multi-user |
| `domain` | TEXT | Hostname without `www.`, e.g. `esdoornkampen.nl` |
| `source_url` | TEXT | URL used for analysis (homepage or listing page) |
| `name` | TEXT | Human-readable name, set by Claude after analysis |
| `tags` | TEXT[] | Up to 10 labels (see Tag vocabulary below) |
| `source_type` | TEXT | `platform` \| `organiser` \| `one_off` |
| `last_analysed_at` | TIMESTAMPTZ | NULL = not yet analysed |
| `created_at` | TIMESTAMPTZ | Default NOW() |
| `updated_at` | TIMESTAMPTZ | Default NOW() |
| UNIQUE | `(user_id, domain)` | One record per domain per user |

### `event_source_refs`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `event_id` | UUID FK | References `events` ON DELETE CASCADE |
| `source_id` | UUID FK | References `event_sources` ON DELETE CASCADE |
| `user_id` | UUID FK | References `users` |
| `ref_type` | TEXT | `enrollment_url` |
| UNIQUE | `(event_id, source_id)` | |

`event_count` is not stored — computed at query time via `COUNT(*)` on `event_source_refs`.

### Tag vocabulary

Claude assigns tags freely, drawn from these categories (not a strict enum):

- **Activity**: `camp`, `workshop`, `course`, `sailing`, `climbing`, `music`, `sports`, `hiking`, `yoga`, `theatre`
- **Audience**: `kids`, `adults`, `family`, `teens`
- **Geography**: country or city names, e.g. `belgium`, `netherlands`, `brussels`
- **Cadence**: `annual`, `seasonal`, `recurring`
- **Format**: `residential`, `daytrip`, `online`, `weekend`

Max 10 tags per source. Claude picks the most discriminating ones.

## Domain extraction (on event create)

Domain extraction happens in **two places** depending on how the event was created:

**UI path (`eventService.ts`):** After the event row is inserted, extract the domain and upsert the source record + ref. Tags are not assigned here — the record is left with `last_analysed_at = NULL` for Claude to pick up later.

```ts
if (data.enrollment_url) {
  const domain = new URL(data.enrollment_url).hostname.replace(/^www\./, '')
  const { data: source } = await supabase
    .from('event_sources')
    .upsert({ user_id, domain, source_url: data.enrollment_url }, { onConflict: 'user_id,domain' })
    .select('id')
    .single()
  if (source) {
    await supabase.from('event_source_refs').upsert(
      { event_id: createdEvent.id, source_id: source.id, user_id, ref_type: 'enrollment_url' },
      { onConflict: 'event_id,source_id' }
    )
  }
}
```

**MCP path (`mcp/src/index.ts`):** The `create_event` tool does the same domain extraction and source upsert internally, then returns source state alongside the created event:

```json
{
  "event": { ... },
  "source": { "id": "...", "is_new": true, "last_analysed_at": null }
}
```

Claude uses this to decide whether to analyse immediately — no separate `upsert_source` call needed after event creation.

Invalid URLs (no protocol, `localhost`, IP addresses) are silently skipped in both paths.

## Source analysis (Claude assigns tags)

### Trigger: after MCP event create

After calling `create_event`, Claude calls `upsert_source`. If the response includes `is_new: true` or `last_analysed_at: null`, Claude:

1. Fetches `source_url` using web fetch
2. Reads the page and assigns up to 10 tags
3. Determines `name` and `source_type`
4. Calls `update_source` to save

### Trigger: explicit user request

User says "analyse my sources" (or similar). Claude calls `get_unanalysed_sources`, then analyses each one in sequence.

## MCP tools

### `upsert_source`

Creates or retrieves a source record for a given domain.

Input: `{ domain: string, source_url: string }`

Returns: `{ id, domain, source_url, name, tags, source_type, last_analysed_at, is_new }`

`is_new` is `true` if the record was just created.

### `update_source`

Saves analysis results.

Input: `{ id: string, name: string, tags: string[], source_type: 'platform' | 'organiser' | 'one_off' }`

Sets `last_analysed_at = NOW()`.

### `get_unanalysed_sources`

Returns all sources where `last_analysed_at IS NULL`.

Input: none

Returns: `[{ id, domain, source_url }]`

### `search_sources`

Queries sources by tag overlap. Used by Claude when answering discovery questions.

Input: `{ tags: string[] }`

Returns: `[{ id, domain, source_url, name, tags, source_type, event_count }]` — sorted by `event_count DESC`.

Uses Postgres array overlap operator: `WHERE tags && $1`.

## Discovery query flow

When the user asks a discovery question:

1. Claude picks relevant tags from the question
2. Calls `search_sources(tags)` → gets matching URLs from the personal source library
3. Fetches those URLs (warm, trusted sources the user has used before)
4. Also runs a web search for broader coverage
5. Combines and presents results

## CLAUDE.md additions

Two short sections:

**After creating an event via MCP** — if `enrollment_url` is present, call `upsert_source`. If `is_new` or `last_analysed_at` is null, fetch the source URL and run analysis.

**For discovery/search questions** — call `search_sources` with relevant tags first, then supplement with web search.

## What is out of scope

- Source badge on event cards (nice-to-have UI, separate task)
- Follow/alert when a source publishes new events (part of discovery-engine backlog item)
- Manual tag editing by the user
- Analysis of sources that require login
