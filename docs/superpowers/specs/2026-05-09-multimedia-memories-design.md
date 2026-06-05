# Plannen multimedia memories (image + video + audio) — Design

**Date:** 2026-05-09
**Status:** Design approved; pending spec review and implementation plan
**Branch:** feat/tier-1-opensource

## Context

Today, `event_memories` only holds photos. Every layer of the app enforces this:

- `event_memories.photo_url` (column name is photo-specific; no kind discriminator)
- File inputs use `accept="image/*"` (`src/components/EventMemory.tsx:165`, `src/components/EventForm.tsx:510,553`)
- Upload handler rejects non-images (`src/components/EventForm.tsx:260`)
- Google Drive picker filters MIMEs to `image/jpeg,image/png,image/gif,image/webp` (`src/utils/googlePicker.ts:63`)
- Display layer renders `<img>` tags only
- Image-specific edge functions (`agent-extract-image`, `memory-image`) and story-cover suggestions assume image content
- MCP `add_event_memory` description references "photo from external source"

The `event-photos` storage bucket itself is permissive (no `allowed_mime_types`, no `file_size_limit` set in `supabase/migrations/20260507000001_event_photos_bucket.sql`). The constraint is everywhere except the bucket.

Users want to attach **videos** (e.g. dance recital clips, kid's first-step recordings) and **audio** (e.g. voice memos describing an event, recital recordings) to events alongside photos. V1 adds both; AI flows that depend on visual content gracefully skip non-image media.

## Goals

1. Allow event memories to be image, video, or audio.
2. Surface all three kinds inline in the event-memories grid and in story body views, using one square tile footprint.
3. Support the same three sources as photos today: direct disk upload, Google Photos picker, Google Drive picker (with the caveat that Google Photos does not host audio).
4. Keep AI-driven image flows working unchanged for image memories, and skip non-image memories cleanly (no errors, no spurious analysis).
5. Round-trip cleanly through `export-seed.sh` + `restore-photos.sh`.

## Non-goals (V1)

- **Compression / transcoding.** Videos are warned at 200 MB but not re-encoded. Adding `ffmpeg.wasm` is deferred to V2 if size becomes a real problem in practice.
- **Poster-frame extraction.** The browser's default poster (first frame, drawn lazily by `<video preload="metadata">`) is sufficient for V1.
- **Waveform thumbnails for audio.** A music-note icon is enough.
- **Video / audio analysis in AI flows.** `agent-extract-image`, `memory-image`, and story-cover candidate-picking filter to image only.
- **Videos as story cover.** Story cover stays image-only — playable covers don't make sense.
- **Playback features beyond native HTML5 controls** (no captions, no annotation, no clip-trim).

## Out of scope but worth noting

- Bucket renaming. The `event-photos` bucket name becomes a misnomer once it holds video and audio too. Renaming requires a storage migration plus rewriting every URL in `event_memories.media_url`. Cost outweighs benefit on a single-user local-only app where users never see the bucket name. We add a comment explaining the historical name in the migration that introduces `media_type`.

## Data model

### Migration

A single migration introduces `media_url` and `media_type`:

```sql
-- supabase/migrations/<ts>_event_memories_media_kind.sql
ALTER TABLE event_memories RENAME COLUMN photo_url TO media_url;

ALTER TABLE event_memories ADD COLUMN media_type text NOT NULL DEFAULT 'image'
  CHECK (media_type IN ('image', 'video', 'audio'));

COMMENT ON COLUMN event_memories.media_url IS
  'Public URL to media in the event-photos bucket. Bucket name is historical — '
  'it now holds image, video, and audio. See media_type for the kind.';
```

Backfill: existing rows are images. The `DEFAULT 'image'` covers them. No data move needed beyond the rename.

### TypeScript model

`src/services/memoryService.ts` `Memory` type:

```ts
export type MediaType = 'image' | 'video' | 'audio'

export interface Memory {
  id: string
  event_id: string
  user_id: string
  media_url: string | null      // was: photo_url
  media_type: MediaType         // new
  caption: string | null
  taken_at: string | null
  source: 'upload' | 'google_drive' | 'google_photos'
  external_id: string | null
  // …
}
```

All `photo_url` references in `src/` and `mcp/` get rewritten to `media_url`.

### MCP

`mcp/src/index.ts` `add_event_memory`:

- Add `media_type?: MediaType` arg, default `'image'`.
- Update tool description to mention "photo, video, or audio attachment", drop the photo-only language.

`list_event_memories`:

- Selects + returns `media_type` in addition to current fields.

`create_photo_picker_session` / `poll_photo_picker_session`:

- Names stay (Google's API is still called the *Photo* Picker even though it can return videos). Tool descriptions are updated to mention "photos and videos".

## Frontend

### Upload sites

Only one input widens — the per-event memory upload. The two `EventForm.tsx` inputs are both image-only by purpose (poster-extract and cover) and stay unchanged:

| File | Line | Today | Change |
|---|---|---|---|
| `src/components/EventMemory.tsx` | 165 | `accept="image/*"` | `accept="image/*,video/*,audio/*"` |
| `src/components/EventForm.tsx` | 510 | `accept="image/*"` | unchanged — **poster-extract** input (uploads a flyer/poster image so the AI can pre-fill event details). Image-only. |
| `src/components/EventForm.tsx` | 553 | `accept="image/*"` | unchanged — **event cover** image. Image-only by design (videos / audio can't be covers). |
| `src/components/EventForm.tsx` | 260 | `if (!file || !file.type.startsWith('image/')) return` | unchanged — guards the poster-extract path. |

Rule: cover and poster-extract stay image-only; only the per-memory upload accepts all three.

### MIME → media_type mapping

When a memory is created from a local file or a downloaded picker asset:

```ts
function mediaTypeFromMime(mime: string): MediaType {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'image'
}
```

### Display in the memories grid

`src/components/EventMemory.tsx` renders one tile per memory. The grid maintains a uniform square tile across kinds:

| `media_type` | Render |
|---|---|
| `image` | `<img src={media_url}>` (today's behavior, unchanged) |
| `video` | `<video src={media_url} controls preload="metadata" className="…tile-styling">` — browser draws first frame as default poster lazily |
| `audio` | tile with a music-note icon (top), caption text (mid), `<audio src={media_url} controls>` (bottom) |

Story body views reuse the same conditional. Story **cover** picker filters server- and client-side to `media_type='image'`.

### Image compression bypass

`src/utils/imageCompression.ts` only runs on images today. After this change, the upload flow checks `media_type` first; non-image uploads skip compression entirely (no canvas work, no JPEG re-encode).

### Size warning

A new pre-upload check in `src/components/EventMemory.tsx` (and the equivalent in `EventForm.tsx`):

```ts
const SOFT_CAP_BYTES = 200 * 1024 * 1024
if (file.size > SOFT_CAP_BYTES && !confirm(
  `${file.name} is ${Math.round(file.size / 1024 / 1024)} MB. ` +
  `It will add to backups and make export-seed.sh slower. Upload anyway?`
)) {
  return
}
```

Confirm/cancel only; nothing is rejected. Applies to all kinds (rare for image, common for video).

### File-input UI copy

The Upload button label stays "Upload" (today's text). The placeholder above the grid changes from "Event Memories" / equivalent to wording that doesn't say "photos". (Exact copy left to implementation; not load-bearing.)

## Google integration

### Drive picker

`src/utils/googlePicker.ts:63` widens MIME filter:

```ts
;(docsView as { setMimeTypes?: (m: string) => unknown }).setMimeTypes?.(
  'image/jpeg,image/png,image/gif,image/webp,' +
  'video/mp4,video/quicktime,video/webm,' +
  'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav'
)
```

### Photos picker

Google Photos hosts photos and videos but **not audio**. The picker session for Photos is widened to images + videos only. Audio is a Drive- or disk-only path.

### Picker session edge functions

`supabase/functions/picker-session-create/` and `supabase/functions/picker-session-poll/` need verification: do they hardcode image content-types when downloading Google-hosted bytes into the bucket, or do they pass through whatever Google returns? If the latter, no change. If the former, the poll function must accept `video/*` and `audio/*` content-types and store them with the same naming scheme as today.

This verification is part of implementation, not design. The implementation plan will read both functions and either confirm "no change needed" or list the specific edits.

## AI flows

The three image-driven edge functions and one server-side helper filter to `media_type='image'`:

| Function | Today | After |
|---|---|---|
| `supabase/functions/agent-extract-image/` | runs on every memory | filter `WHERE media_type = 'image'` |
| `supabase/functions/memory-image/` | image-only by purpose; no filter today (works because all memories are images) | add explicit filter; raise `Bad Request` if invoked on non-image memory |
| Story-cover suggestion (in story-generation flow) | picks any memory | filter to `media_type='image'` |
| Story-generation prompt construction | embeds memory URLs into prompt | for non-image memories, embed `[VIDEO: <caption>]` / `[AUDIO: <caption>]` text instead of a URL the vision model can't consume |

No new AI capabilities in V1. Videos and audio are pass-through data — the user's playback in the browser is the only "consumer."

## Storage backup / restore

`scripts/restore-photos.sh` already maps file extensions to MIME types (lines for `jpg|jpeg|png|gif|webp|heic|heif|mp4|mov`). Add audio extensions:

```sh
mp3)       mime=audio/mpeg ;;
m4a)       mime=audio/mp4 ;;
wav)       mime=audio/wav ;;
ogg)       mime=audio/ogg ;;
```

`scripts/export-seed.sh` does not change — it dumps `event_memories` whole, and the archive captures `/mnt` whole. The new `media_type` column rides along automatically.

## Testing

### Vitest unit

- `mediaTypeFromMime` returns `'video'` / `'audio'` / `'image'` for representative MIMEs.
- `memoryService.uploadMemory` writes the right `media_type` based on the file's MIME.
- The size-warning component shows the prompt above 200 MB and skips it below.

### Manual verification

- Upload an MP4 from disk; tile renders as `<video>`, plays inline.
- Upload an M4A from disk; tile renders as audio tile with `<audio controls>` bar; plays inline.
- Pick a video from the Google Drive picker; lands in the grid as a video tile.
- Pick a video from the Google Photos picker; lands in the grid as a video tile.
- Open a story view that contains a mix of image + video + audio memories; all three render.
- Open the story-cover picker for a story whose event has a video; the video does not appear as a candidate.
- Run `bash scripts/export-seed.sh` then a `supabase db reset` then `bash scripts/restore-photos.sh`; all three kinds serve HTTP 200 after restore.

### Regression

Existing image-only flows must not regress:

- Upload a JPEG; it still passes through `imageCompression.ts` and serves correctly.
- `agent-extract-image` runs only against image rows.
- A story whose event has only images still picks an image cover.

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| Upload of unrecognized MIME (e.g. `application/pdf`) | User force-selects a non-media file via "All files" picker | Frontend rejects before upload: "Plannen supports image, video, and audio only." |
| Storage bucket fills disk | Many large videos | Native disk-full behavior on `supabase` container; `/plannen-doctor` already covers Supabase health |
| `picker-session-poll` returns video bytes when picker filter wasn't widened | implementation gap | Out-of-scope file is stored with `media_type='image'` and the `<img>` tag fails to load. UI must show a fallback ("media unavailable") rather than a broken image icon. |
| Audio stored from Google Drive with an unusual MIME (e.g. `application/ogg` instead of `audio/ogg`) | Drive content-type heuristics | Fall back to extension-based detection if MIME is non-`audio/` but extension is in our audio list |

## Open questions

None as of design approval. The picker-session-poll content-type pass-through behavior is a verification item, not a design open question — the implementation plan addresses it inline.

## What lands in V1.1+ (deferred)

- ffmpeg.wasm-based optional video compression with an "optimize before upload" toggle
- Poster-frame extraction for video (server- or client-side)
- Waveform thumbnails for audio
- Frame-extraction-based vision analysis (story cover from a video, AI captioning of a video frame)
- A `/plannen-trim-clip <event> <memory> <start> <end>` slash command for in-place clip editing
- Bucket rename from `event-photos` to `event-media` (only worth doing if there's another reason to migrate storage)
