# Audit 05 — Stories & Memories

Read-only audit of the components that capture, display, and operate on event
memories and stories in the Plannen web app, plus the generic `AgentChat`
surface that sits in `MyFeed`. All references are absolute file paths inside
`/Users/stroomnova/Music/plannen/.worktrees/plannen-ui/`.

## Summary

- **Stories cannot be created from the web UI.** There is no `create_story`
  call in the React tree. Stories are exclusively produced by the plugin
  (`/plannen-write-story`) writing rows into the `stories` table; the web
  surface (`MyStories`, `EventStorySection`, `StoryReader`) only lists,
  reads, edits, deletes, and re-covers them.
- **Multi-language story switching works.** `StoryReader` renders sibling
  language pills from `story.siblings` and navigates via
  `Link to=/stories/<sibling.id>`. Fallback to a single language is handled
  by simply not rendering the picker (`if (story.siblings.length > 1)` at
  `src/components/StoryReader.tsx:124`).
- **Story-language picker lives only in `Settings.tsx`** (max 3, ordered).
  `Profile` does NOT expose languages — minor UX inconsistency with the
  rest of the profile fields.
- **Memory capture is upload-only.** No in-browser recording, no
  `transcribe_memory` invocation. `accept="image/*,video/*,audio/*"` lets
  the user pick a pre-recorded audio file, but the transcription pipeline
  is never triggered from the UI (only via MCP from a Claude session).
- **AgentChat is misnamed.** Despite the name and `useAgent()` hook, it is
  *only* a one-shot discovery form invoking the `agent-discover` Supabase
  function and turning the chosen card into an `EventFormData` prefill.
  No chat history, no conversation, no streaming. The "AgentChat" name is
  legacy.
- **BYOK gate is enforced client-side in `AgentChat`** with a clear
  remediation message. `EventMemory` / `EventForm`'s scrape paths do NOT
  pre-check `hasAiKey` and will fail at the function call instead.
- **`StoryPhotoStrip` and `CoverPicker` share a near-identical Tier-0/Tier-1
  branch.** Both pull from `event_memories` filtered to
  `media_type === 'image'` and ignore Google-Photos-backed memories that
  have `media_url = null` (source `google_photos` / `google_drive`). Those
  memories silently disappear from the strip and cover picker.
- **`MemoryImage` lazy-loads cross-origin proxied media via `fetch` → blob →
  `URL.createObjectURL`.** Native `loading="lazy"` is only used in
  `StoryPhotoStrip` thumbnails, not in `MemoryImage` itself.

## Components reviewed

| Component | Path | Lines | Mounted from | Role |
|---|---|---|---|---|
| `MyStories` | `src/components/MyStories.tsx` | 115 | `pages/Dashboard.tsx:93` (`view=stories`) | List + hero card grid of stories, deduped by language |
| `StoryReader` | `src/components/StoryReader.tsx` | 247 | `routes/AppRoutes.tsx:44` (`/stories/:id`) | Read / edit / delete / re-cover one story, language switcher |
| `StoryPhotoStrip` | `src/components/StoryPhotoStrip.tsx` | 113 | `StoryReader.tsx:117` | Inline thumbnail strip; selecting a thumb overrides cover preview locally |
| `EventStorySection` | `src/components/EventStorySection.tsx` | 45 | `EventDetailsModal.tsx:190` | Read-only teaser in event detail; "Edit" deep-links to reader |
| `EventMemory` | `src/components/EventMemory.tsx` | 371 | `EventDetailsModal.tsx:189`, `EventCard.tsx:917` | Upload / Drive / Photos picker, lightbox, delete |
| `MemoryImage` | `src/components/MemoryImage.tsx` | 142 | inside `EventMemory` grid + lightbox | Renders image/video/audio with tier-aware proxy fallback |
| `CoverPicker` | `src/components/CoverPicker.tsx` | 100 | `StoryReader.tsx:229` | Grid of attached event photos for cover selection |
| `AgentChat` | `src/components/AgentChat.tsx` | 281 | `MyFeed.tsx:195` | Discovery form → calls `agent-discover` → seeds `EventForm` |

Supporting modules cross-referenced:

- `src/services/storyService.ts` — `listStories`, `getStory`, `getEventStory`,
  `updateStory`, `deleteStory`. **No `createStory` export.**
- `src/services/memoryService.ts` — `getEventMemories`, `uploadMemory`,
  `addMemoryFromGoogle`, `deleteMemory`. **No `transcribeMemory` export.**
- `src/services/profileService.ts:58` — `getStoryLanguages`,
  `setStoryLanguages` (the only callers are `MyStories.tsx:87` and
  `Settings.tsx:60,117`).
- `src/hooks/useStories.ts`, `useStory.ts`, `useEventStory.ts`
- `src/hooks/useAgent.ts` — `scrapeUrl`, `extractFromImage`
- `src/utils/storyLanguages.ts` — canonical 12-language list + `labelFor`
- `src/utils/storySubtitle.ts` — formats the date/event subtitle line
- `src/lib/dbClient/types.ts:188-200` — `stories.create` / `memories.create`
  exist as typed surface area but no UI calls `dbClient.stories.create`.
- MCP server (`mcp/src/index.ts`) — owns `create_story`, `get_story_languages`,
  `set_story_languages`, `transcribe_memory`.

## Flows reviewed

### Create story

There is no UI entry point. Searches across the worktree confirm it:

```
$ grep -rn "create_story\|createStory" src
(no matches)
```

Both empty states acknowledge this:

- `MyStories.tsx:96` — "No stories yet. Ask the agent to write one for any
  past event."
- `EventStorySection.tsx:18` — "No story yet. Ask the agent to write one for
  this event."

The only `dbClient.stories.create` consumer in the type system is the
contract test; production code never calls it. Stories therefore arrive
exclusively via the plugin's `/plannen-write-story` slash command, which
calls the MCP `create_story` tool that writes directly into the `stories`
table. `useStories` subscribes to `realtime.subscribeToStories`
(`src/hooks/useStories.ts:25`), so a story written by the plugin appears
in `My Stories` without a page reload — in Tier 1 via Supabase Realtime,
in Tier 0 via the polling shim.

BYOK relevance: because creation happens in a Claude session, the user's
configured BYOK key (or Claude Code CLI subprovider, see
`Settings.tsx:217-222`) is what the *plugin* uses; the web app neither
provides nor checks an AI key for story creation. There is therefore no
"no provider configured" surface on this flow in the UI — failure mode is
silent (the story just never appears).

### Read story (and language switching)

Entry points:

- `MyStories.tsx:48` (`HeroCard`) and `:67` (`GridCard`) link to
  `/stories/<id>`.
- `EventStorySection.tsx:39` links to `/stories/<id>` ("Read full") and
  `/stories/<id>?edit=1` ("Edit").

`StoryReader` (`src/components/StoryReader.tsx`):

- Loads via `useStory(id)` (`:22`).
- Reads the `?edit=1` query param at `:20` to open in edit mode.
- Renders cover (or `PLACEHOLDER_GRADIENT` at `:110` when absent).
- Renders `StoryPhotoStrip` with `linkedEventIds` (`:117`).
- **Language switcher**: `:124-148`. If `story.siblings.length > 1`, renders
  a row of pills. The active language is a `<span>` with `aria-current="page"`;
  inactive ones are `<Link>` to `/stories/<sibling.id>`. The single-language
  case is the silent fallback — no picker rendered, no flicker.
- Body is split on `\n{2,}` into paragraphs (`bodyToParagraphs` at `:13`).
- Inline edit: replaces title with `<input>` and body with `<textarea>`
  (`:155-184`), validates non-empty at `:56`, calls
  `updateStory(story.id, { title, body })` (`:63`).
- Cover change opens `CoverPicker` at `:229`, then
  `updateStory(story.id, { cover_url: url })` at `:75`.
- Delete confirms with an inline modal at `:232` and routes back to
  `/dashboard?view=stories` after `deleteStory(story.id)`.

Dedupe in the list view: `MyStories.tsx:9-25` keeps one story per
`story_group_id`, picking the highest-priority language from
`preferredLangs`. Users with `['en','mr','nl']` see the English version on
the index and can click into a story to switch to `mr` or `nl` via the
sibling pills.

Multi-language fetch caveat: `storyService.getStory` (lines 31-46) lists
*all* stories and filters client-side to find siblings — there is no
indexed endpoint. Comment at `:37-39` acknowledges this is intentional but
expensive once the user has many stories.

### Add event memory (text)

There is no plain-text memory path in the UI. The `EventMemory` component
only renders a file picker + optional caption (`EventMemory.tsx:163-202`,
`:229-248`). The caption text becomes `memory.caption` but is always
attached to a media file — a memory with `media_url=null` and only a
caption is not creatable from the UI.

The MCP `add_event_memory` tool *does* accept a text-only memory, so a
Claude session can create one; the web app would then render it via
`MemoryImage`'s "No media" branch (`MemoryImage.tsx:106-109`). The caption
is shown beneath the placeholder tile in the grid (`EventMemory.tsx:269`),
which is the only place text-only memories surface.

### Add event memory (photo)

Three paths, all in `EventMemory.tsx`:

1. **Direct upload** (`:90-103`): `handleUpload` → `uploadMemory(eventId,
   file, caption)` in `memoryService.ts:35`. Images are compressed via
   `compressImage` (`memoryService.ts:51`) and stored through
   `dbClient.memories.uploadFile`. A row is then inserted with
   `media_url`, `media_type`, `caption`, `source: 'upload'` (`:74-80`).
   Large-file warning at `shouldWarnLargeFile` (`memoryService.ts:120`).
2. **Google Drive picker** (`:115-132`): `getGoogleAccessToken` → open
   `openGoogleDrivePicker` → for each selected item call
   `addMemoryFromGoogle(eventId, 'google_drive', item.id, undefined,
   item.mimeType)`. Rows are inserted with `media_url=null`,
   `source='google_drive'`, `external_id` (`memoryService.ts:96-103`).
3. **Google Photos picker** (`:134-146`): `createPhotoPickerSession` opens
   a new tab and polls every 3 s (`:58-88`). The session result reports
   `attached`/`skipped` counts. Polling errors surface as `googleError`.

For sources 2 and 3 the displayed image is fetched through
`/functions/v1/memory-image` (`MemoryImage.tsx:33-39`), which means the
proxy is BYOK-independent (it uses the user's stored Google OAuth token
server-side, not the Anthropic key).

UI quirks:

- `handleConnectGoogle` does `window.location.href = url`
  (`EventMemory.tsx:109`), which **navigates the whole tab away** during
  OAuth. Any unsaved memory-uploader state (`file`, `caption`) is lost.
- `googleConnected` is `null` before the probe and renders nothing — fine,
  but the buttons can pop in late after first paint.

### Add event memory (audio + transcribe)

- The file input accepts audio: `accept="image/*,video/*,audio/*"`
  (`EventMemory.tsx:167`).
- `mediaTypeFromMime` (`src/utils/mediaType.ts:11`) detects
  `audio/*` and stores `media_type='audio'`.
- `MemoryImage` renders `AudioTile` (`:113-141`) — a music icon plus an
  `<audio controls>` element. Lightbox variant auto-plays.
- **There is no in-browser recording UI.** No `getUserMedia`, no
  `MediaRecorder`, no record button. The user must arrive with a finished
  audio file.
- **`transcribe_memory` is never called by the web UI.** No reference in
  the entire `src/` tree. The `MemoryRow` type (`dbClient/types.ts:57-59`)
  reserves `transcript`, `transcript_lang`, `transcribed_at`, but no
  component reads or writes them — the caption beneath the audio tile is
  the only visible text. A transcript created by a Claude session via
  `transcribe_memory` would not appear anywhere in the UI today.

### Cover picker

`CoverPicker` (`src/components/CoverPicker.tsx`) is mounted **only** from
`StoryReader.tsx:229` when the user clicks the "Cover" button at `:167`.
It is not used by events themselves — `EventForm` has its own `image_url`
field and uses the standalone `agent-extract-image` function.

Source set: `event_memories` rows whose `event_id` is in the story's
linked events (`linkedEventIds = story.events.map(e => e.id)` at
`StoryReader.tsx:53`) and where `media_type === 'image'` and `media_url
IS NOT NULL`. Sorted by `taken_at ASC, created_at ASC`.

Tier branching: `TIER === '0'` uses `dbClient.memories.list({ event_id })`
per event then flattens (`CoverPicker.tsx:30-43`); `TIER === '1'` issues
one `supabase.from('event_memories').select(...).in('event_id', eventIds)`
(`:50-58`). Two near-identical implementations also appear in
`StoryPhotoStrip.tsx:32-66` — see the duplication issue below.

Empty state: "No photos attached to the linked events." (`:78`).

**Gap**: Google-backed memories (`media_url IS NULL`, `source='google_photos'`)
are silently filtered out. The user has no way to pick a Google Photos
image as a story cover — they must first upload it locally.

### AgentChat

Mounted at `MyFeed.tsx:195-203` above the event list with a `ref` for
external reset. Despite the name there is no chat history, no message
list, no streaming, no conversational state.

Flow (`AgentChat.tsx`):

1. User types a query, submits.
2. BYOK pre-check: `if (!hasAiKey)` at `:42`. If missing:

   ```ts
   setError('No AI provider configured. Open AI Settings (the "AI" button in
   the nav bar) and paste your Anthropic key.')
   return
   ```

   This is the canonical "no provider configured" surface the
   plannen-core skill mandates — clear, actionable.
3. `dbClient.functions.invoke('agent-discover', { query })` at `:52-55`.
4. Response is run through `normalize` (`:70-96`): dedupes by host,
   demotes social-media domains, caps at 5.
5. On "Add This Event" the picked result is hydrated via
   `scrapeUrl(result.url)` (`:115`) — calls `agent-scrape` — and the
   merged extracted fields seed an `EventFormData` payload (`:137-154`).
6. Parent (`MyFeed`) receives the data and opens `EventForm` with it
   (`MyFeed.tsx:198-202`).

Error rendering (`:199-207`) includes a quick-checks block listing
`backend-start.sh`, `/settings`, browser console, and TROUBLESHOOTING.md
— useful for the most common BYOK / backend-missing failures.

Is it usable today? Yes, provided:

- Tier-0 backend is up on 54323 (`agent-discover` and `agent-scrape` are
  HTTP-shimmed there); or Tier-1 edge functions are deployed.
- BYOK key saved in `user_settings` (or Claude Code CLI provider in
  Tier 0 with the CLI installed — `SettingsContext.tsx:226`,
  `Settings.tsx:175-179`).

Note: `useAgent.scrapeUrl` does NOT pre-check `hasAiKey`
(`src/hooks/useAgent.ts:8-15`). If the user picks a discovery result with
no key (impossible from this flow because `handleDiscover` blocks first,
but possible from `EventForm`'s direct URL scrape), the call hits
`agent-scrape` which should return a server-side error envelope. Worth
verifying in an EventForm audit.

### MemoryImage rendering

`src/components/MemoryImage.tsx`:

- Detects source: `source === 'google_drive' || source === 'google_photos'`
  marks `isProxy = true` (`:22`).
- Upload-sourced media renders directly from `memory.media_url` (`:60-75`)
  with no proxy round-trip. Image uses plain `<img>` — **no
  `loading="lazy"` attribute**, unlike `StoryPhotoStrip.tsx:100`.
- Proxy-sourced media: `useEffect` (`:24-58`) fetches the proxied URL,
  reads it as a blob, and calls `URL.createObjectURL`. Cleanup revokes
  the object URL on unmount. This is correct for cross-origin auth but
  has a side effect: each visible tile creates a separate blob URL
  (no shared cache), so an event with 30 Drive photos creates 30 blob
  URLs at once when the modal opens.
- Tier branching at `:33-41`: Tier 0 uses same-origin `/functions/v1/...`
  via Vite proxy (no Bearer); Tier 1 attaches the supabase session token.
- Failure modes:
  - `(error || (isProxy && !proxyUrl))` after a failed fetch → "Media
    unavailable" tile (`:92-98`).
  - `isProxy && !proxyUrl` while pending → animated "Loading…" skeleton
    (`:99-104`).
  - Upload source with no `media_url` → "No media" tile (`:106-110`).
- Video: renders `<video controls>` with `preload="metadata"` in the grid
  and `autoPlay` in lightbox.
- Audio: `AudioTile` (`:113-141`) — Lucide `Music` icon + native
  `<audio controls>`. No transcript display.

### Multi-language UI presence

- **List**: `getStoryLanguages` is called in `MyStories.tsx:87` to drive
  the dedupe priority. The user never sees a picker on this page — it
  just renders their preferred-language version of each group.
- **Reader**: sibling pills (`StoryReader.tsx:124-148`) — visible only
  when ≥ 2 translations exist.
- **Picker**: only in `Settings.tsx:300-353`. Renders the 12 codes from
  `STORY_LANGUAGES`, max 3 selected, order matters (canonical first).
  Persisted via `setStoryLanguages` → `dbClient.profile.update({
  story_languages })`.

The user's preference `['en','mr','nl']` (memory note `user_story_languages`)
is honoured by `MyStories` and by `getStoryLanguages` defaulting to `['en']`
when the row is empty (`profileService.ts:61-64`).

## Issues found

### [BROKEN]

(none observed in static review)

### [RISKY]

**R1. Story creation has no web UI and no failure surface.**
`MyStories.tsx:96` and `EventStorySection.tsx:18` both tell users to "ask
the agent." If the user has no Claude session connected (BYOK saved but
no MCP client running), or the plugin isn't installed, there is no
diagnostic in the web app — stories simply never appear. The
plannen-core "no provider configured" hint is only wired into
`AgentChat` (`:43`); it should also appear on these empty states (e.g.
"Open Claude / Claude Code and run `/plannen-write-story`").
File refs: `src/components/MyStories.tsx:92-99`,
`src/components/EventStorySection.tsx:14-21`.

**R2. Google-backed memories cannot serve as a story cover or photo strip.**
`CoverPicker.tsx:54-55` and `StoryPhotoStrip.tsx:60-61` both filter
`media_type='image'` AND `media_url IS NOT NULL`. Drive/Photos memories
are stored with `media_url=null` (`memoryService.ts:96-103`) and only
become viewable through the `memory-image` proxy. The strip and picker
silently skip them — the user can attach a Google Photo to an event but
never select it as the story cover.

**R3. `MemoryImage` blob explosion for proxied sources.** Each visible
tile in `EventMemory`'s grid opens a `fetch` and creates a fresh
`URL.createObjectURL` (`MemoryImage.tsx:43-49`). For an event with many
Drive/Photos memories this fires one network request per tile on mount.
No shared cache, no observer-based lazy loading. On a slow connection
the user sees the "Loading…" skeleton on every tile simultaneously.
Suggested fix: gate the fetch behind `IntersectionObserver` or use a
shared module-level Promise cache keyed by `memory.id`.

**R4. `handleConnectGoogle` full-page redirect from `EventMemory`.**
`EventMemory.tsx:109` does `window.location.href = url`. Anything the
user had set up — pending photo-picker session, file selection, caption
— is lost. The Photos picker uses a `window.open` flow with polling
(`:139`); the same approach would work for the OAuth bootstrap and keep
the modal state alive.

**R5. `dbClient.stories.create` exists but is unreachable.**
`src/lib/dbClient/types.ts:191` declares the typed surface, and both
tiers implement it (`tier0.ts:71`, `tier1.ts:96`). Nothing in the web
app calls it. This is fine if intentional (plugin-only creation) but
makes the contract test claim a feature the web UI deliberately omits.

### [MINOR]

**M1. Story-language picker is on `Settings`, not `Profile`.** All other
profile-shaped fields (locations, interests, goals, family) sit on the
`/profile` page. Story languages live on `/settings`. The split is fine
once you know it but is not signposted. Considering surfacing both
(or moving languages to `Profile`).

**M2. `MemoryImage` does not set `loading="lazy"` on its `<img>`.**
`StoryPhotoStrip.tsx:100` does. `MemoryImage.tsx:74,90` does not. For
grids the native attribute is the cheap win before any IO observer work.

**M3. `useStory.getStory` fetches every story to find siblings.**
`src/services/storyService.ts:31-46` lists *all* stories client-side to
build the sibling array (acknowledged in the comment). Once a user has
hundreds of translations this hurts. A future `dbClient.stories.list({
group_id })` would eliminate it.

**M4. `useEventStory` swallows errors.** `src/hooks/useEventStory.ts:15`
catches, `console.error`s, and sets `story = null`. From the user's
perspective the "No story yet" empty state is shown for both "really
no story" and "the request failed" — they can't distinguish.

**M5. `StoryPhotoStrip` and `CoverPicker` are 80 % duplicated.** Both
load attached image memories for a list of event IDs with identical
tier branches. Worth extracting an `useEventImageMemories(eventIds)`
hook.

**M6. `MemoryImage` has no `alt`-text affordance.** It defaults to
`alt=""` (`:17`). Captions are stored on `memory.caption` and would be
the obvious source for non-decorative `alt`.

**M7. `AgentChat` is named for a chat surface it never was.** Renaming
to `EventDiscoveryForm` (and the file likewise) would help future
contributors. Also, the import in `MyFeed.tsx:10` and the
`AgentChatHandle`/`resetDiscovery` interface (`AgentChat.tsx:9-11`)
already use "Discovery" terminology — the component name is the only
holdout.

**M8. `MyStories` hard-coded gradient fallback.**
`MyStories.tsx:27` and `StoryReader.tsx:11` both define
`PLACEHOLDER_GRADIENT` independently. Extract once.

**M9. Story editor lacks markdown / preview.** Body is split on blank
lines into `<p>` (`StoryReader.tsx:13`) but the editor is a plain
`<textarea>`. Inline emphasis, headings, etc. from MCP-generated stories
will render as plain text. The MCP `create_story` tool description
doesn't guarantee markdown either, so this is consistent — flagged for
expectation alignment only.

**M10. `EventMemory` lightbox dependency on stable index.**
`EventMemory.tsx:46-47` uses `(i - 1 + memories.length) % memories.length`
arithmetic that breaks if a memory is deleted while the lightbox is
open — the indices shift. Acceptable for single-user mode but worth a
comment.

## Open questions

1. **Is plugin-only story creation a permanent product decision?** If so,
   `EventStorySection` should at least surface "open Claude Code and run
   `/plannen-write-story`" rather than the generic "ask the agent" prompt.
   Consider also a deep-link to a documented slash command.
2. **Should the cover picker include Google Photos-sourced memories?**
   Showing them needs the proxy fetch + cover_url that survives the
   external-ID indirection — non-trivial because `stories.cover_url` is
   stored as a string URL, not a memory ID.
3. **Where will `transcribe_memory` results surface?** The DB columns
   exist (`transcript`, `transcript_lang`, `transcribed_at`) but no UI
   reads them. Open whether the audio tile should show the transcript
   inline, link to it, or feed it into story generation.
4. **Should `MyStories` show an in-progress / scheduled-routine state?**
   If a user has queued a "write a story" routine via the
   `plannen:schedule` skill, the UI could indicate that a story is
   pending — currently the only signal is its appearance via Realtime.
5. **Is `dbClient.stories.create` actually used by any test or future
   migration script?** If not, dropping it from the type would prevent
   accidental bypassing of the plugin's prompts/permissions.
6. **Should `EventForm`'s scrape path mirror `AgentChat`'s `hasAiKey`
   pre-check?** Right now a user with no key can still click "Scrape URL"
   in `EventForm` and rely on the server to refuse — worth confirming in
   the EventForm audit.
7. **Is the Profile vs Settings split intentional?** Story languages are
   the only profile-shaped data not on `/profile`. Either move it or add
   a cross-link.
