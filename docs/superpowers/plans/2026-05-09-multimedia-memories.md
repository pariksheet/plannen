# Multimedia memories (image + video + audio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `event_memories` to hold images, videos, and audio — uploadable from disk, Google Drive, and Google Photos (audio: disk + Drive only) — rendering each kind inline in the memories grid and story body, while keeping image-only AI flows working unchanged.

**Architecture:** Single migration renames `photo_url` → `media_url` and adds `media_type ('image'|'video'|'audio')`. The web-app display layer branches on `media_type` (img / video / audio tile). Image-driven edge functions and story-cover suggestions filter to `media_type='image'`; non-image memories pass through as data only. No new dependencies.

**Tech stack:** React + Vite, Vitest (jsdom), Supabase (Postgres + Storage + Edge Functions on Deno), Node MCP server (TS).

**Spec:** `docs/superpowers/specs/2026-05-09-multimedia-memories-design.md`

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `supabase/migrations/<ts>_event_memories_media_kind.sql` | **create** | Rename column, add `media_type`, comment historical bucket name |
| `src/utils/mediaType.ts` | **create** | `MediaType` type + `mediaTypeFromMime` helper |
| `tests/utils/mediaType.test.ts` | **create** | Unit test for the helper |
| `src/services/memoryService.ts` | modify | Type rename, queries, upload sets `media_type` |
| `src/components/MemoryImage.tsx` | modify | Branch render: img / video / audio tile (keep filename — misnomer, see Task 4) |
| `src/components/EventMemory.tsx` | modify | Widen `accept`, MIME detect on upload, size warning, lightbox handles all kinds |
| `src/utils/googlePicker.ts` | modify | Widen Drive picker MIMEs |
| `mcp/src/index.ts` | modify | Tool descriptions, query selects, insert sets `media_type`, story-cover filter |
| `supabase/functions/picker-session-poll/index.ts` | modify | Pass content-type through; set `media_type` from MIME |
| `supabase/functions/agent-extract-image/index.ts` | modify | Filter to `media_type='image'` |
| `supabase/functions/memory-image/index.ts` | modify | Type field rename only (proxy still passes any binary) |
| `scripts/restore-photos.sh` | modify | Extend MIME map with audio extensions |

**Rationale for not renaming `MemoryImage` / `memory-image`:** they're misnomers after this change but renaming them adds search-and-replace churn across the codebase without behavior change. Per the spec, accepted misnomers (also see `event-photos` bucket) are documented in code comments. This keeps the diff focused on real behavior.

---

## Task 1: Migration + TS type updates

**Files:**
- Create: `supabase/migrations/<timestamp>_event_memories_media_kind.sql` (Supabase CLI picks the timestamp)
- Modify: `src/services/memoryService.ts`
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Generate migration file**

```bash
supabase migration new event_memories_media_kind
```

This creates an empty file like `supabase/migrations/20260509120000_event_memories_media_kind.sql`. Note the actual filename — it's the canonical reference for later steps.

- [ ] **Step 2: Write the migration**

Open the file from Step 1 and paste:

```sql
-- Rename event_memories.photo_url -> media_url and add media_type to support
-- video and audio alongside images. The storage bucket is still called
-- 'event-photos' (it predates this change); renaming the bucket would force
-- a rewrite of every URL value, which isn't worth the churn on a single-user
-- app where the bucket name is internal.

ALTER TABLE event_memories RENAME COLUMN photo_url TO media_url;

ALTER TABLE event_memories
  ADD COLUMN media_type text NOT NULL DEFAULT 'image'
  CHECK (media_type IN ('image', 'video', 'audio'));

COMMENT ON COLUMN event_memories.media_url IS
  'Public URL to media in the event-photos bucket. Bucket name is historical — '
  'it now holds image, video, and audio. See media_type for the kind.';
```

- [ ] **Step 3: Apply the migration locally**

```bash
supabase migration up
```

Expected output: `migrations applied` (or "Local database is up to date" if it ran already during a previous attempt).

- [ ] **Step 4: Verify the schema**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "\d event_memories" | grep -E 'media_url|media_type'
```

Expected: two lines showing `media_url | text` and `media_type | text  ... default 'image'::text`.

- [ ] **Step 5: Backfill default for existing rows**

The `DEFAULT 'image'` in the migration covers new rows. Existing rows already got `'image'` because the column was added with `NOT NULL DEFAULT`. Confirm:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "SELECT media_type, count(*) FROM event_memories GROUP BY 1;"
```

Expected: one row, `image | <N>`.

- [ ] **Step 6: Update memoryService TypeScript types**

In `src/services/memoryService.ts`, find the `EventMemory` (or `Memory`) interface and update:

```ts
export type MediaType = 'image' | 'video' | 'audio'
export type MemorySource = 'upload' | 'google_drive' | 'google_photos'

export interface EventMemory {
  id: string
  event_id: string
  user_id: string
  media_url: string | null         // was: photo_url
  media_type: MediaType            // new
  caption: string | null
  taken_at: string | null
  created_at: string
  source: MemorySource | null
  external_id: string | null
}
```

Update every `select(...)` string in this file: replace `photo_url` with `media_url, media_type`. Update every insert/update payload's `photo_url` key to `media_url`; new inserts must include `media_type` (default to `'image'` for now — Task 5 wires real MIME detection).

- [ ] **Step 7: Update MCP types and selects**

In `mcp/src/index.ts`, do the equivalent rename. The grep below lists the lines that touch `photo_url` (run it to confirm count, then update each):

```bash
grep -n "photo_url" mcp/src/index.ts
```

Expected lines (around 304, 328, 398, 400, 404, 661, 1366) all need:
- `select` strings: `photo_url` → `media_url, media_type`
- Insert payloads: `photo_url` → `media_url`; add `media_type: 'image'` until Task 9 differentiates
- Tool description in `list_event_memories` (line ~1366): change "Returns id, event_id, photo_url, ..." → "Returns id, event_id, media_url, media_type, ..."

The cover-photo selection at lines 398–404 (filters memories with `not('photo_url', 'is', null)`) becomes:

```ts
.select('media_url, media_type, taken_at, created_at')
.not('media_url', 'is', null)
.eq('media_type', 'image')          // covers stay image-only
```

- [ ] **Step 8: Build the MCP and run typecheck**

```bash
cd mcp && npm run build && cd ..
npx tsc --noEmit
```

Expected: both succeed without errors.

- [ ] **Step 9: Run existing tests; fix any photo_url references**

```bash
npm test
```

Expected: pass. If anything fails referencing `photo_url`, change to `media_url` in the test file. (No existing tests touch `photo_url` per a pre-implementation grep, so this should be a no-op; this step is the safety net.)

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/*event_memories_media_kind.sql \
  src/services/memoryService.ts \
  mcp/src/index.ts
git commit -m "feat(memories): rename photo_url to media_url, add media_type"
```

---

## Task 2: `mediaType` helper + unit test

**Files:**
- Create: `src/utils/mediaType.ts`
- Create: `tests/utils/mediaType.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/mediaType.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mediaTypeFromMime } from '../../src/utils/mediaType'

describe('mediaTypeFromMime', () => {
  it('returns image for image MIMEs', () => {
    expect(mediaTypeFromMime('image/jpeg')).toBe('image')
    expect(mediaTypeFromMime('image/png')).toBe('image')
    expect(mediaTypeFromMime('image/heif')).toBe('image')
  })

  it('returns video for video MIMEs', () => {
    expect(mediaTypeFromMime('video/mp4')).toBe('video')
    expect(mediaTypeFromMime('video/quicktime')).toBe('video')
    expect(mediaTypeFromMime('video/webm')).toBe('video')
  })

  it('returns audio for audio MIMEs', () => {
    expect(mediaTypeFromMime('audio/mpeg')).toBe('audio')
    expect(mediaTypeFromMime('audio/mp4')).toBe('audio')
    expect(mediaTypeFromMime('audio/x-m4a')).toBe('audio')
    expect(mediaTypeFromMime('audio/wav')).toBe('audio')
  })

  it('falls back to image for unknown / empty MIME', () => {
    expect(mediaTypeFromMime('')).toBe('image')
    expect(mediaTypeFromMime('application/pdf')).toBe('image')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/utils/mediaType.test.ts
```

Expected: FAIL with "Failed to resolve import" (the helper file doesn't exist yet).

- [ ] **Step 3: Create the helper**

Create `src/utils/mediaType.ts`:

```ts
export type MediaType = 'image' | 'video' | 'audio'

/**
 * Map a MIME type (e.g. from File.type) to the Plannen media kind.
 * Falls back to 'image' for unknown / empty MIMEs because the existing
 * upload paths historically only handled images and the fallback keeps
 * pre-multimedia rows behaving the same.
 */
export function mediaTypeFromMime(mime: string): MediaType {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'image'
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/utils/mediaType.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Re-export the type from memoryService for compat**

`src/services/memoryService.ts` currently defines `MediaType` inline (from Task 1). Replace the inline definition with a re-export so there's only one source of truth:

```ts
export type { MediaType } from '../utils/mediaType'
```

(Drop the duplicate `export type MediaType = ...` line.)

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/mediaType.ts tests/utils/mediaType.test.ts src/services/memoryService.ts
git commit -m "feat(memories): add mediaTypeFromMime helper + tests"
```

---

## Task 3: Wire MIME → `media_type` into upload paths

**Files:**
- Modify: `src/services/memoryService.ts`
- Modify: `src/components/EventMemory.tsx` (only the upload site / handler in this task; display is Task 4)

- [ ] **Step 1: Locate the upload function in memoryService**

```bash
grep -n "from('event_memories')" src/services/memoryService.ts | head
```

Find the function that inserts a row after a file upload (around line 45 per the earlier grep — `photo_url: publicUrl`). Note its signature.

- [ ] **Step 2: Update the upload function signature and body**

Change the function to accept and use `media_type`. Example diff:

```ts
// Before
async function uploadMemory(eventId: string, file: File, caption?: string) {
  // …upload to bucket, get publicUrl…
  await supabase.from('event_memories').insert({
    event_id: eventId,
    user_id: userId,
    photo_url: publicUrl,
    caption: caption ?? null,
    source: 'upload',
  })
}

// After
import { mediaTypeFromMime } from '../utils/mediaType'

async function uploadMemory(eventId: string, file: File, caption?: string) {
  // …upload to bucket, get publicUrl…
  await supabase.from('event_memories').insert({
    event_id: eventId,
    user_id: userId,
    media_url: publicUrl,
    media_type: mediaTypeFromMime(file.type),
    caption: caption ?? null,
    source: 'upload',
  })
}
```

- [ ] **Step 3: Skip image compression for non-image uploads**

In the same function, find where `compressImage(file)` (or similar from `src/utils/imageCompression.ts`) is called. Wrap it:

```ts
const fileToUpload = mediaTypeFromMime(file.type) === 'image'
  ? await compressImage(file)
  : file
```

If the upload code currently passes `file` to compression unconditionally, this branch lets video and audio bytes pass through untouched.

- [ ] **Step 4: Add the size warning**

Still in `memoryService.ts` (or in `EventMemory.tsx` if the warning is more appropriate at the UI layer — pick whichever the existing upload flow makes natural). Pre-upload check:

```ts
const SOFT_CAP_BYTES = 200 * 1024 * 1024

export function shouldWarnLargeFile(file: File): string | null {
  if (file.size <= SOFT_CAP_BYTES) return null
  const mb = Math.round(file.size / 1024 / 1024)
  return `${file.name} is ${mb} MB. It will add to backups and make export-seed.sh slower. Upload anyway?`
}
```

In `EventMemory.tsx`, before calling `handleUpload`, check it:

```ts
const warning = shouldWarnLargeFile(file)
if (warning && !confirm(warning)) return
```

- [ ] **Step 5: Widen the file input accept attribute**

In `src/components/EventMemory.tsx` line ~165:

```tsx
<input
  type="file"
  accept="image/*,video/*,audio/*"
  className="hidden"
  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
/>
```

(`EventForm.tsx:510` and `EventForm.tsx:553` stay `image/*` — those are the poster-extract and event-cover paths, both image-only by design.)

- [ ] **Step 6: Run typecheck and tests**

```bash
npx tsc --noEmit && npm test
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/memoryService.ts src/components/EventMemory.tsx
git commit -m "feat(memories): wire media_type into uploads + size warning"
```

---

## Task 4: Display branches in `MemoryImage` (img / video / audio tile)

**Files:**
- Modify: `src/components/MemoryImage.tsx`

The component name stays `MemoryImage` despite now rendering all three kinds — see the file-structure note above.

- [ ] **Step 1: Add a `media_type` branch for the upload path**

In `MemoryImage.tsx`, find the `if (source === 'upload' && memory.photo_url)` block (now `media_url` after Task 1). Replace it with a branch on `media_type`:

```tsx
if (source === 'upload' && memory.media_url) {
  if (memory.media_type === 'video') {
    return (
      <video
        src={memory.media_url}
        controls
        preload="metadata"
        className={className}
      />
    )
  }
  if (memory.media_type === 'audio') {
    return <AudioTile memory={memory} url={memory.media_url} className={className} />
  }
  return <img src={memory.media_url} alt={alt} className={className} />
}
```

- [ ] **Step 2: Add the same branch for the proxy path (Google Drive / Photos)**

Find the `if (isProxy && proxyUrl)` block. Replace with the same three-way branch using `proxyUrl` instead of `media_url`:

```tsx
if (isProxy && proxyUrl) {
  if (memory.media_type === 'video') {
    return <video src={proxyUrl} controls preload="metadata" className={className} />
  }
  if (memory.media_type === 'audio') {
    return <AudioTile memory={memory} url={proxyUrl} className={className} />
  }
  return <img src={proxyUrl} alt={alt} className={className} />
}
```

- [ ] **Step 3: Implement `AudioTile` inside the same file**

At the bottom of `MemoryImage.tsx`, add:

```tsx
function AudioTile({
  memory,
  url,
  className,
}: {
  memory: EventMemory
  url: string
  className?: string
}) {
  return (
    <div className={`flex flex-col items-stretch bg-gray-100 ${className ?? ''}`}>
      <div className="flex-1 flex items-center justify-center text-gray-400">
        {/* lucide-react Music icon — already used elsewhere in the codebase */}
        <Music className="w-8 h-8" />
      </div>
      <audio src={url} controls className="w-full" />
    </div>
  )
}
```

Add the `Music` import at the top of the file: `import { Music } from 'lucide-react'`.

- [ ] **Step 4: Update the "unavailable" / "loading" placeholders to be media-kind-agnostic**

Change "Photo unavailable" to "Media unavailable" and "No image" to "No media" in the same component. These are fallbacks the user sees rarely; they shouldn't lie about kind.

- [ ] **Step 5: Manual smoke check**

In another terminal, start the dev server and confirm the existing image grid still renders normally:

```bash
npm run dev
```

Open the event detail page for an event that has photos. All photos should render the same as before. (Video/audio grid rendering is verified end-to-end in Task 11.)

- [ ] **Step 6: Run typecheck and tests**

```bash
npx tsc --noEmit && npm test
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/MemoryImage.tsx
git commit -m "feat(memories): render video and audio tiles in memories grid"
```

---

## Task 5: Lightbox handles all three kinds

**Files:**
- Modify: `src/components/EventMemory.tsx` (lightbox section, around lines 285–360)

- [ ] **Step 1: Find the lightbox content area**

```bash
grep -n "lightboxMemory" src/components/EventMemory.tsx
```

Locate the JSX that renders the full-size view inside the lightbox (where `<img src={lightboxMemory.photo_url}>` or similar appears). Note the surrounding markup.

- [ ] **Step 2: Branch the lightbox content on `media_type`**

Replace the single `<img>` in the lightbox center with:

```tsx
{lightboxMemory.media_type === 'video' && lightboxMemory.media_url ? (
  <video
    src={lightboxMemory.media_url}
    controls
    autoPlay
    className="max-h-[80vh] max-w-full"
  />
) : lightboxMemory.media_type === 'audio' && lightboxMemory.media_url ? (
  <div className="flex flex-col items-center gap-4 text-white">
    <Music className="w-24 h-24 text-gray-400" />
    {lightboxMemory.caption && <p className="text-sm">{lightboxMemory.caption}</p>}
    <audio src={lightboxMemory.media_url} controls autoPlay className="w-96 max-w-full" />
  </div>
) : (
  <img
    src={lightboxMemory.media_url ?? undefined}
    alt={lightboxMemory.caption ?? ''}
    className="max-h-[80vh] max-w-full object-contain"
  />
)}
```

If the lightbox uses the proxy URL flow (via `MemoryImage` rather than direct `<img>`), reuse `MemoryImage` with a new `mode="lightbox"` prop instead of duplicating logic. Inspect first; pick the simplest path.

- [ ] **Step 3: Update the delete-button aria label**

Change `aria-label="Delete photo"` → `aria-label="Delete memory"` on both the tile-overlay button and the lightbox close-area button.

- [ ] **Step 4: Manual smoke check**

```bash
npm run dev
```

Click any existing photo memory → lightbox should still display it correctly (image branch unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/components/EventMemory.tsx
git commit -m "feat(memories): lightbox renders video and audio in addition to images"
```

---

## Task 6: Google Drive picker — widen MIME filter

**Files:**
- Modify: `src/utils/googlePicker.ts`

- [ ] **Step 1: Locate the MIME-filter call**

```bash
grep -n "setMimeTypes" src/utils/googlePicker.ts
```

Confirm the line is around `:63` and matches the pattern from the spec.

- [ ] **Step 2: Widen the MIME list**

Replace:

```ts
;(docsView as { setMimeTypes?: (m: string) => unknown }).setMimeTypes?.(
  'image/jpeg,image/png,image/gif,image/webp'
)
```

With:

```ts
;(docsView as { setMimeTypes?: (m: string) => unknown }).setMimeTypes?.(
  'image/jpeg,image/png,image/gif,image/webp,' +
  'video/mp4,video/quicktime,video/webm,' +
  'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav'
)
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/utils/googlePicker.ts
git commit -m "feat(memories): allow video and audio in Google Drive picker"
```

---

## Task 7: `picker-session-poll` — set `media_type` from downloaded content-type

**Files:**
- Modify: `supabase/functions/picker-session-poll/index.ts`

- [ ] **Step 1: Read the current insert path**

```bash
grep -n "photo_url\|content-type\|contentType\|media_type" supabase/functions/picker-session-poll/index.ts
```

Confirm where the function inserts `event_memories` rows after downloading bytes from Google. After Task 1, this insert was renamed to `media_url` but doesn't yet set `media_type`.

- [ ] **Step 2: Capture the content-type from the download response**

In the section where the function fetches the photo bytes from Google (`fetch(...)` → `await res.blob()` or similar), capture `res.headers.get('content-type')` into a local:

```ts
const contentType = res.headers.get('content-type') ?? ''
```

- [ ] **Step 3: Determine media_type from content-type with extension fallback**

Add a helper at the top of the file (Deno: import URL from a relative path is fine, but copying a tiny helper is simpler than wiring shared imports across the Deno boundary):

```ts
function pickMediaType(contentType: string, filename: string | undefined): 'image' | 'video' | 'audio' {
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('image/')) return 'image'
  // Fallback to extension
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? ''
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio'
  return 'image'
}
```

- [ ] **Step 4: Update the insert payload**

```ts
await db.from('event_memories').insert({
  event_id: eventId,
  user_id: userId,
  media_url: publicUrl,
  media_type: pickMediaType(contentType, item.mediaFile?.filename),
  caption: null,
  source: 'google_photos',     // or 'google_drive' depending on the function
  external_id: item.id,
})
```

- [ ] **Step 5: Pass content-type through to storage upload**

When the function uploads the bytes to the bucket via `storage.from('event-photos').upload(...)`, ensure `contentType` is forwarded:

```ts
await db.storage.from('event-photos').upload(path, bytes, {
  contentType: contentType || 'application/octet-stream',
  upsert: true,
})
```

(If the existing call already does this with `contentType: 'image/jpeg'` hardcoded, switch the constant to the captured `contentType`.)

- [ ] **Step 6: Restart functions-serve and test the picker manually**

```bash
bash scripts/functions-stop.sh && bash scripts/functions-start.sh
```

Then in the web app, pick a video from Google Drive and confirm the row inserted has `media_type='video'`:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "SELECT media_type, source, substring(media_url,1,80) FROM event_memories ORDER BY created_at DESC LIMIT 5;"
```

Expected: most-recent row has `media_type=video`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/picker-session-poll/index.ts
git commit -m "feat(memories): picker-session-poll sets media_type from content-type"
```

---

## Task 8: `agent-extract-image` — filter to `media_type='image'`

**Files:**
- Modify: `supabase/functions/agent-extract-image/index.ts`

- [ ] **Step 1: Find the memory query**

```bash
grep -n "event_memories\|photo_url\|media_url" supabase/functions/agent-extract-image/index.ts
```

If the function queries `event_memories` directly (e.g. to pick an image for analysis), add a `.eq('media_type', 'image')` filter. If it accepts a memory id and analyzes that one, add a guard right after fetching the row:

```ts
if (memory.media_type !== 'image') {
  return new Response(
    JSON.stringify({ error: 'Image extraction only supports image memories', code: 'unsupported_media_type' }),
    { status: 400, headers: corsHeaders }
  )
}
```

- [ ] **Step 2: Restart functions-serve**

```bash
bash scripts/functions-stop.sh && bash scripts/functions-start.sh
```

- [ ] **Step 3: Manual check**

Verify a story-cover-extract operation against an event with mixed media still works for image memories and surfaces the 400 cleanly if invoked on a video. (If story-cover never invokes this against a video — because cover selection filters to image first — the 400 is just a defense-in-depth guard.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-extract-image/index.ts
git commit -m "feat(memories): agent-extract-image rejects non-image memories"
```

---

## Task 9: MCP — story cover filter, prompt-friendly listing

**Files:**
- Modify: `mcp/src/index.ts` (story-cover selection at lines ~398–404, tool descriptions at ~1352, ~1366, ~1377)

- [ ] **Step 1: Story cover selection**

This was already partially done in Task 1 Step 7. Double-check that `createStory` picks covers only from images:

```bash
grep -n -A6 "Optional override; defaults to first memory by taken_at\|coverUrl = mem" mcp/src/index.ts
```

The cover selection block should already include `.eq('media_type', 'image')`. If it doesn't, add it.

- [ ] **Step 2: Update `add_event_memory` tool description**

Find the tool registration (~line 1351). Replace its description with:

```ts
description: 'Attach a photo, video, or audio clip from an external source (Google Photos, Google Drive) to an event by external id only. NOTE: for Google Photos, prefer create_photo_picker_session + poll_photo_picker_session — those download the bytes and store them locally so the UI can display the media. add_event_memory only stores the id and is for advanced/manual cases. Idempotent on (event_id, external_id).',
```

Also add `media_type` to the input schema:

```ts
inputSchema: {
  type: 'object',
  properties: {
    // …existing fields…
    media_type: {
      type: 'string',
      enum: ['image', 'video', 'audio'],
      description: 'Kind of media being attached. Defaults to image for backwards compat.',
    },
  },
  required: [/* same as before */],
},
```

In the `addEventMemory` handler, default to `'image'` if absent:

```ts
const mediaType = (args.media_type as 'image' | 'video' | 'audio' | undefined) ?? 'image'
// …in the insert payload…
media_type: mediaType,
```

- [ ] **Step 3: Update `list_event_memories` tool description**

```ts
description: 'List memories attached to an event, ordered by taken_at ASC (NULLS LAST), then created_at ASC. Returns id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source. Used by the agent before generating a story so it can fetch and view the photos and decide how to surface videos and audio in the narrative.',
```

- [ ] **Step 4: Update `create_story` tool description**

```ts
description: 'Create (or overwrite, if event_ids has length 1 and a story already exists for that event) an AI-generated story. The agent composes title and body itself using event details, photos, and any video/audio captions before calling this. Pass event_ids for event-bound stories or date_from+date_to for date-range stories. cover_url defaults to the first IMAGE memory by taken_at across all linked events; videos and audio are never picked as covers.',
```

- [ ] **Step 5: Build and test MCP**

```bash
cd mcp && npm run build && npm test && cd ..
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): describe and accept video/audio in event memories"
```

---

## Task 10: `restore-photos.sh` — extend MIME map for audio

**Files:**
- Modify: `scripts/restore-photos.sh`

- [ ] **Step 1: Locate the MIME-from-extension `case` block**

```bash
grep -nA3 "case \"\$ext\"" scripts/restore-photos.sh
```

- [ ] **Step 2: Add audio extensions**

Inside the `case "$ext" in` block, before the `*)` fallback, add:

```sh
mp3)       mime=audio/mpeg ;;
m4a)       mime=audio/mp4 ;;
wav)       mime=audio/wav ;;
ogg)       mime=audio/ogg ;;
flac)      mime=audio/flac ;;
```

- [ ] **Step 3: Verify with shellcheck (if installed)**

```bash
command -v shellcheck >/dev/null && shellcheck scripts/restore-photos.sh
```

Expected: clean (warnings about the embedded heredoc are pre-existing and acceptable).

- [ ] **Step 4: Test the restore round-trip**

Smoke test: take a backup, drop one storage row, re-run restore, confirm it comes back:

```bash
bash scripts/export-seed.sh
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "SELECT count(*) FROM storage.objects;"
# note the count
bash scripts/restore-photos.sh   # idempotent; should report same count
```

Expected: count after `restore-photos.sh` matches the count before.

- [ ] **Step 5: Commit**

```bash
git add scripts/restore-photos.sh
git commit -m "feat(restore-photos): include audio extensions in MIME map"
```

---

## Task 11: End-to-end manual verification

No code changes. This task is a checklist of acceptance scenarios. Each one must pass before opening the PR.

- [ ] **Step 1: Direct disk upload — image (regression)**

Open an event in the web app. Click Upload, select a `.jpg`. Confirm:
- File uploads (no errors in browser console)
- Tile renders as `<img>` in the grid
- Clicking the tile opens the lightbox with the image
- DB row has `media_type='image'`, `source='upload'`

- [ ] **Step 2: Direct disk upload — video**

Same flow with an `.mp4` (under 200 MB). Confirm:
- No size warning shown (under cap)
- Tile renders as `<video controls>`; hitting play streams the file
- Lightbox opens video full-size with autoplay
- DB row has `media_type='video'`

- [ ] **Step 3: Direct disk upload — audio**

Same flow with an `.m4a`. Confirm:
- Tile shows the music-note icon and `<audio controls>` bar
- Clicking the tile opens the lightbox with a larger audio player
- DB row has `media_type='audio'`

- [ ] **Step 4: Size warning**

Upload a `.mp4` larger than 200 MB. Confirm a `confirm()` dialog appears with the file size and "Upload anyway?" wording. Cancelling stops the upload; accepting completes it.

- [ ] **Step 5: Google Drive picker — video**

Click "From Google Drive" → pick a video. Confirm it lands in the grid as a video tile, the DB row has `source='google_drive'` and `media_type='video'`, and the file plays via the proxy.

- [ ] **Step 6: Google Drive picker — audio**

Same, with an audio file. Same expectations with `media_type='audio'`.

- [ ] **Step 7: Google Photos picker — video**

Click "From Google Photos" → pick a video. Confirm same as Step 5 but with `source='google_photos'`.

- [ ] **Step 8: Story cover picker excludes non-images**

Open Stories → create a new story for an event that contains a mix. The cover-picker UI (or the auto-default) must not surface videos or audio as candidates.

- [ ] **Step 9: Story body renders all kinds**

Open a story whose event has all three kinds of memories. Confirm each kind renders inline using the same tile branching.

- [ ] **Step 10: Backup round-trip**

```bash
bash scripts/export-seed.sh
# (Then in the web app, delete one of each kind to prove restore brings them back.)
# Actually safer: just verify the archive contains all three.
tar tvzf supabase/seed-photos.tar.gz | wc -l
```

Expected count matches `find /mnt/stub/stub/event-photos -type f | wc -l`. Then run restore on a clean state and confirm all three kinds serve HTTP 200.

- [ ] **Step 11: AI flow regression**

Trigger an AI image-extract operation against an event that has only image memories (e.g. via `/plannen-write-story` in Claude Code with the plugin loaded). Confirm it works exactly as before. Trigger it against an event that has a video — confirm it skips the video cleanly (either no-op or "no images" message, not an error).

- [ ] **Step 12: Open the PR**

```bash
git push
gh pr create --title "feat: multimedia event memories (image + video + audio)" \
  --body "Implements docs/superpowers/specs/2026-05-09-multimedia-memories-design.md per the plan in docs/superpowers/plans/2026-05-09-multimedia-memories.md."
```

---

## Self-review

Spec coverage check (each spec section maps to a task):

| Spec section | Task |
|---|---|
| Data model — migration | Task 1 |
| TypeScript model | Task 1 (Step 6, 7) |
| MCP changes | Task 1 (Step 7), Task 9 |
| Frontend upload sites | Task 3 (Step 5) |
| MIME → media_type | Task 2, Task 3 |
| Display in memories grid | Task 4 |
| Lightbox | Task 5 |
| Image compression bypass | Task 3 (Step 3) |
| Size warning | Task 3 (Step 4) |
| Drive picker MIMEs | Task 6 |
| Photos picker (video only, audio N/A) | Task 7 (verified end-to-end in Step 6, Task 11 Step 7) |
| picker-session-poll content-type | Task 7 |
| AI flows filter | Task 8, Task 9 (Step 1) |
| Story cover image-only | Task 1 (Step 7), Task 9 (Step 1) |
| Story body all kinds | Task 4, Task 5 (reused) |
| `restore-photos.sh` audio MIMEs | Task 10 |
| Failure modes (unrecognized MIME, oversize, etc.) | Task 3 (Step 4 size warning), Task 8 (400 on non-image AI) |
| Testing — vitest unit | Task 2 |
| Testing — manual | Task 11 |
| Regression | Task 11 (Step 1, Step 11) |

No gaps. No placeholders (every code step has the actual code). Type names consistent (`MediaType`, `media_url`, `media_type`, `mediaTypeFromMime`).
