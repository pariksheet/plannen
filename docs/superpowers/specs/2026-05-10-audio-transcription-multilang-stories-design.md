# Audio transcription + multi-language stories — Design

**Date:** 2026-05-10
**Status:** Design pending approval
**Branch:** feat/tier-1-opensource

## Context

The previous iteration (`2026-05-09-multimedia-memories-design.md`) opened `event_memories` to video and audio. Audio is now stored and plays in the browser, but it carries no text — the story-generation skill explicitly skips audio for vision and treats `caption` as the only context. Users who upload a voice memo get nothing in the story unless they manually caption it.

Separately, story output is currently English-only in practice. The user wants up to three languages per story, generated together so the same memory yields parallel narratives.

Both features land together because they share the story workflow: transcript becomes story context, and the same composition pass produces every language.

## Goals

1. **Optional local transcription.** If `whisper-cli` is installed on PATH, audio memories are transcribed automatically and the transcript becomes story context. If it isn't installed, audio still uploads + plays — the story flow simply doesn't see audio content.
2. **Multi-language stories.** A user picks up to three languages in `/settings`. `/plannen-write-story` produces one story row per configured language, all linked to the same event(s) and grouped so the UI can show language tabs.
3. **No new external API key.** Transcription is host-side (whisper.cpp). Translation reuses the existing Anthropic BYOK key.

## Non-goals (V1)

- **Cloud transcription fallback.** No OpenAI Whisper / Gemini path. If a user wants transcription they install whisper.cpp; otherwise the feature is silently disabled. (Easy to add a Tier-2 fallback later if needed.)
- **Per-event language overrides.** All three languages are global per user. No "this trip only in EN+NL".
- **Background / pre-emptive transcription.** Transcription runs on demand from the story skill, not on upload. (Voice memos used outside stories don't pay the transcription cost.)
- **Translating existing stories.** This design only generates fresh multi-language stories. A backfill / "translate this old story" command can come later.
- **Editing translations independently.** Editing one language's body doesn't auto-update the others. The user can edit each row directly.
- **Delete-cascade across siblings.** Deleting one language's story does NOT delete its translations. They're independent rows that happen to share `story_group_id`.

## Architecture overview

```
[ User uploads audio ] ──► event_memories row (media_type='audio', transcript=null)
                                  │
                                  ▼
[ /plannen-write-story ] ──► plannen-stories skill
                                  │
                                  ├─► transcribe_memory (MCP) ── whisper-cli ──► transcript saved on row
                                  │
                                  ├─► get_story_languages (MCP) ──► ['en', 'nl', 'fr']
                                  │
                                  ├─► compose canonical story (Anthropic, vision + transcript)
                                  │
                                  └─► for each lang:
                                        translate via Anthropic
                                        create_story({ language: 'xx', story_group_id: <shared> })
```

Three new touchpoints: a migration, an MCP transcribe tool, and a settings panel for languages. Story composition workflow lives in the plugin skill, unchanged in shape.

## Data model

### Migration: `<ts>_audio_transcript_and_story_lang.sql`

```sql
-- Audio transcript captured by host-side whisper.cpp. Separate from user-set caption.
ALTER TABLE event_memories
  ADD COLUMN transcript TEXT,
  ADD COLUMN transcript_lang TEXT,                  -- BCP-47 (e.g. 'en', 'nl-NL')
  ADD COLUMN transcribed_at TIMESTAMPTZ;

COMMENT ON COLUMN event_memories.transcript IS
  'Auto-generated transcript from whisper.cpp for audio memories. NULL means not yet '
  'transcribed (or whisper not installed at the time the user invoked story generation). '
  'caption remains the user-editable field.';

-- Story language. One row per (story_group, language). Default 'en' covers existing rows.
ALTER TABLE stories
  ADD COLUMN language TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN story_group_id UUID NOT NULL DEFAULT uuid_generate_v4();

-- Existing rows: each gets a unique group_id from the DEFAULT (uuid_generate_v4 evaluated
-- per row). New rows of the same translation group share an explicitly-passed group_id.

CREATE INDEX stories_group_idx ON stories(story_group_id);
CREATE INDEX stories_user_lang_generated_idx
  ON stories(user_id, language, generated_at DESC);

-- Up to 3 languages from a curated list. Stored on user_profiles, not user_settings —
-- it's a profile preference, not a BYOK provider setting.
ALTER TABLE user_profiles
  ADD COLUMN story_languages TEXT[] NOT NULL DEFAULT '{en}',
  ADD CONSTRAINT story_languages_max_3 CHECK (array_length(story_languages, 1) <= 3),
  ADD CONSTRAINT story_languages_nonempty CHECK (array_length(story_languages, 1) >= 1);
```

The `story_group_id` lives on `stories` because:
- Sibling translations share it. UI fetches all stories with the same group to show language pills.
- It survives event-link changes (you can edit `story_events` without breaking the group).
- A story without translations is just a singleton group.

### TypeScript types

`src/types/story.ts`:
```ts
export interface Story {
  id: string
  user_id: string
  story_group_id: string                // siblings share this
  language: string                       // BCP-47 short ('en', 'nl', 'fr')
  title: string
  body: string
  cover_url: string | null
  user_notes: string | null
  mood: string | null
  tone: string | null
  date_from: string | null
  date_to: string | null
  generated_at: string
  edited_at: string | null
  created_at: string
  updated_at: string
}

export interface StoryWithSiblings extends StoryWithEvents {
  siblings: { id: string; language: string }[]   // all rows in the same group, including self
}
```

`src/services/memoryService.ts` Memory type adds:
```ts
export interface Memory {
  // ... existing fields
  transcript: string | null
  transcript_lang: string | null
  transcribed_at: string | null
}
```

### MCP changes

**New tool: `transcribe_memory`**

```jsonc
{
  "name": "transcribe_memory",
  "description": "Transcribe an audio event_memory using a host-side whisper.cpp install. \
Reads the audio bytes from Supabase Storage, spawns `whisper-cli`, parses the result, and \
persists transcript + transcript_lang on the row. Idempotent — returns the existing transcript \
if already populated. Returns { ok: false, error: 'whisper_not_installed' } if whisper-cli is \
not on PATH so callers can degrade gracefully. Image and video rows return error 'unsupported_media_type'.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "memory_id": { "type": "string" },
      "force": { "type": "boolean", "description": "Re-transcribe even if transcript already set" }
    },
    "required": ["memory_id"]
  }
}
```

Returns shape:
```ts
{ ok: true, transcript: string, language: string, cached: boolean }
| { ok: false, error: 'whisper_not_installed' | 'unsupported_media_type' | 'fetch_failed' | 'whisper_failed', detail?: string }
```

**New tool: `get_story_languages`**

```jsonc
{
  "name": "get_story_languages",
  "description": "Return the user's configured story languages from user_profiles.story_languages. \
Order matters — first entry is the canonical language used for the initial composition; subsequent \
entries are translations. Always returns at least one language ('en' default).",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
}
```

Returns: `{ languages: string[] }`.

**Updated tool: `create_story`**

Adds two optional fields:
```ts
language?: string         // BCP-47 short, default 'en'
story_group_id?: string   // pass to link this story as a translation of an existing group
```

Single-event overwrite logic changes from `WHERE event_id = X AND user_id = me` to `WHERE event_id = X AND user_id = me AND language = L`. So generating an EN story for event X overwrites the prior EN story for X but does not touch the NL one.

If `story_group_id` is passed and an existing story shares it for the same event_ids and language, that's the overwrite path. Otherwise a new row is inserted with the supplied (or fresh) group_id.

**Updated tool: `list_event_memories`**

Selects `transcript, transcript_lang, transcribed_at` so the plugin can decide whether to call `transcribe_memory`.

**Updated tool: `get_story`**

Returns `siblings: [{id, language}]` from the same `story_group_id`.

### Profile service

`src/services/profileService.ts` already manages `user_profiles`. Add:
```ts
export async function getStoryLanguages(userId: string): Promise<string[]>
export async function setStoryLanguages(userId: string, languages: string[]): Promise<void>
```

`setStoryLanguages` validates: 1–3 entries, each in the allowed list, deduplicated.

## whisper.cpp integration

### Install path

`bash scripts/bootstrap.sh` — at the end, an optional step:

```sh
echo
echo "Optional: install whisper.cpp for audio transcription in stories?"
echo "  - macOS:   brew install whisper-cpp"
echo "  - Linux:   build from https://github.com/ggerganov/whisper.cpp"
echo "  - Skip:    audio still uploads + plays; story-skill just won't see audio content."
read -r -p "Install via brew now? [y/N] " yn
case "$yn" in
  [Yy]*)
    brew install whisper-cpp || echo "(brew failed — install manually if you want this)"
    download_whisper_model_if_missing
    ;;
esac
```

`download_whisper_model_if_missing` fetches `ggml-base.en.bin` (~150 MB, multilingual but biased toward English) into `~/.plannen/whisper/ggml-base.en.bin`. This default works for most users; users on other languages can swap it for `ggml-medium.bin` etc. and point at it via env var.

### Env var

`.env` gains:
```sh
# Path to whisper.cpp model file. Defaults to ~/.plannen/whisper/ggml-base.en.bin.
# Set to 'disabled' to opt out even if whisper-cli is installed.
PLANNEN_WHISPER_MODEL=
```

### MCP shell-out

`mcp/src/transcribe.ts` (new file):

```ts
import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_MODEL = `${process.env.HOME}/.plannen/whisper/ggml-base.en.bin`

export async function whisperAvailable(): Promise<boolean> {
  if (process.env.PLANNEN_WHISPER_MODEL === 'disabled') return false
  return await commandExists('whisper-cli')
}

export async function transcribeAudioBytes(
  bytes: Uint8Array,
  hint: { contentType?: string; ext?: string } = {},
): Promise<{ transcript: string; language: string }> {
  const ext = hint.ext ?? extFromContentType(hint.contentType) ?? 'm4a'
  const dir = tmpdir()
  const base = join(dir, `plannen-${randomUUID()}`)
  const inputPath = `${base}.${ext}`
  const txtPath = `${base}.txt`
  await writeFile(inputPath, bytes)

  const model = process.env.PLANNEN_WHISPER_MODEL || DEFAULT_MODEL
  // -otxt: write plain text alongside the input file (whisper-cli puts <input>.txt next to it)
  // -l auto: detect language; -nt: no timestamps
  const args = ['-m', model, '-f', inputPath, '-otxt', '-l', 'auto', '-nt']
  const { stdout, stderr, code } = await runCmd('whisper-cli', args)
  if (code !== 0) {
    await safeUnlink(inputPath, txtPath)
    throw new Error(`whisper-cli exited ${code}: ${stderr.slice(-500)}`)
  }
  const transcript = (await readFile(txtPath, 'utf8')).trim()
  const language = parseDetectedLanguage(stderr) ?? 'en'
  await safeUnlink(inputPath, txtPath)
  return { transcript, language }
}
```

Audio-fetch path inside the MCP tool handler:
```ts
async function transcribeMemory(args: { memory_id: string; force?: boolean }) {
  if (!await whisperAvailable()) return { ok: false, error: 'whisper_not_installed' }

  const row = await db.from('event_memories').select('id, media_type, media_url, transcript').eq('id', args.memory_id).maybeSingle()
  if (!row.data) throw new Error('memory not found')
  if (row.data.media_type !== 'audio') return { ok: false, error: 'unsupported_media_type' }
  if (row.data.transcript && !args.force) {
    return { ok: true, cached: true, transcript: row.data.transcript, language: row.data.transcript_lang ?? 'en' }
  }

  // Fetch bytes via Supabase service-role client (works for any storage object)
  const bytes = await fetchStorageBytes(row.data.media_url)
  const { transcript, language } = await transcribeAudioBytes(bytes, { contentType: extractContentType(row.data.media_url) })

  await db.from('event_memories').update({
    transcript, transcript_lang: language, transcribed_at: new Date().toISOString(),
  }).eq('id', args.memory_id)

  return { ok: true, cached: false, transcript, language }
}
```

### plannen-doctor

Add a check between AI-provider and Google-OAuth:

```
9. **whisper-cli availability**. Try `command -v whisper-cli`.
   - Pass: present.
   - Warning if missing → `→ brew install whisper-cpp` (mac) — story flow will skip audio.
   - Skipped (silent pass) if `PLANNEN_WHISPER_MODEL=disabled`.

10. **whisper model file present** (only checked if check 9 passed).
    - Pass: file at `$PLANNEN_WHISPER_MODEL` or `~/.plannen/whisper/ggml-base.en.bin` exists.
    - Warning otherwise → `→ download a model: https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.en.bin into ~/.plannen/whisper/`.
```

## Story composition workflow

`plugin/skills/plannen-stories.md` updates:

### New step 4a (insert before vision sampling)

> **Transcribe audio memories.** For each memory where `media_type === 'audio'` and `transcript` is null, call `transcribe_memory({ memory_id })`. Add `1` to a counter per success; log nothing on `whisper_not_installed` errors. The skill must not abort or warn the user if whisper isn't installed — audio is treated as caption-only context, exactly like today.

### Updated step 5 (compose)

> **Resolve languages.** Call `get_story_languages()` to get the configured set. **Then ask the user which subset to generate for this story.** Format:
>
> > "Your configured languages are English, Nederlands, Français. Which would you like for this story? (default: all three; reply with a subset like 'en, nl' to limit, or 'en' for just one.)"
>
> Wait for the response. The skill must ask this every time, even if the user already answered earlier in the conversation — translation cost is per-call, not per-session. The only phrasings that skip this pause are *"all"*, *"all configured"*, or *"just <lang>"* explicitly named in the original `/plannen-write-story` invocation. Single-language users (only one language configured) skip the prompt automatically.
>
> **Compose.** The first selected language is canonical — compose the title and body in that language using vision + audio transcripts + captions. Then for each remaining selected language, ask the model to translate the canonical story (preserving the same paragraph structure, tone, and proper nouns). Persist each language as a separate `create_story` call sharing the same `story_group_id`:
>
> ```
> // first call generates the group_id (don't pass one)
> { id: id1, story_group_id: group } ← create_story({ event_ids, title, body, language: langs[0] })
>
> // subsequent calls reuse it
> for (const lang of langs.slice(1)) {
>   create_story({ event_ids, title: translatedTitle, body: translatedBody, language: lang, story_group_id: group })
> }
> ```

### Single-language users (no behavior change)

If `get_story_languages()` returns `['en']` only, the workflow degenerates to today's flow exactly — one composition, one `create_story` call with `language='en'`, no translation step, no language-selection prompt.

### Per-story override

The user can pass an explicit subset in the slash command, e.g. `/plannen-write-story Eline's birthday in nl, fr` or `/plannen-write-story <event> just english`. The skill parses these and skips the language-selection pause.

## Frontend

### Settings page (`src/components/Settings.tsx`)

Below the Anthropic key card, add a new card:

```
┌─ Story languages ──────────────────────────────────┐
│ Stories are generated in your selected languages   │
│ (max 3). The first language is the canonical one.  │
│                                                    │
│  [✓ English]  [✓ Nederlands]  [   Français]        │
│  [   Deutsch]  [   Español]    [   Italiano]       │
│  [   Português] [   हिन्दी ]    [   मराठी ]          │
│  [   日本語]    [   中文]       [   العربية]         │
│                                                    │
│  Selected order: English, Nederlands               │
│  [Save]                                            │
└────────────────────────────────────────────────────┘
```

Curated list (BCP-47 short codes):
```ts
const STORY_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'mr', label: 'मराठी' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
]
```

The order users click in is the saved order (canonical first).

### Story view

`src/components/StoryDetail.tsx` (or wherever a story renders today):

- Fetch the story's siblings via `get_story` (which now returns `siblings`).
- If `siblings.length > 1`, render language pills above the title — clicking one navigates to that sibling's `id`.

### My Stories list

Filter to `language = 'en'` (or the first preferred language) by default so the same trip doesn't appear three times. A small pill on each card showing other available translations is enough — no separate filter UI in V1.

## Caption display unchanged

The memories grid still shows the user-set `caption`. Transcripts live in DB only and surface in story prompts and (optionally) in the lightbox detail view as `Transcript: …` below the audio player.

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| Whisper not installed | User skipped optional step | `transcribe_memory` returns `{ok: false, error: 'whisper_not_installed'}`. Plugin proceeds without transcript context. No user-facing error. |
| Whisper model missing | Binary on PATH but model file absent | `whisper-cli` exits non-zero. MCP returns `{ok: false, error: 'whisper_failed', detail: stderr}`. Plugin logs it once and proceeds without transcript. |
| Storage fetch fails | Supabase down or row stale | `{ok: false, error: 'fetch_failed'}`. Same handling as above. |
| Translation produces wrong language | Anthropic doesn't follow instruction | The story still saves in the requested `language` slot; user can edit. (No automated language detection on output in V1.) |
| User picks 4+ languages | Frontend bug | Settings save rejects via the CHECK constraint; UI shows "max 3". |
| User picks 0 languages | Frontend bug | Save defaults back to `['en']`. |
| Existing single-language story for event | User regenerates | Overwrite logic scoped by `(event_id, language)` — same-language story is replaced; sibling translations untouched. |
| Group-id mismatch on translation | Plugin bug | `create_story` does not enforce that all rows in a `story_group_id` link to the same events. UI just renders whatever the group contains. Acceptable for V1. |

## Testing

### Vitest unit

- `getStoryLanguages` reads from `user_profiles.story_languages`; defaults to `['en']` when row missing.
- `setStoryLanguages` rejects empty arrays, >3 entries, and unknown codes.
- New helper `parseDetectedLanguage(stderr)` extracts the language from whisper-cli's `auto-detected language: nl (p = …)` output.

### MCP (mcp/test or vitest)

- `transcribe_memory` returns `whisper_not_installed` when stub `commandExists` returns false.
- `transcribe_memory` is idempotent: second call without `force` returns `cached: true` and doesn't shell out.
- `create_story` with `language: 'nl'` doesn't overwrite an existing `language: 'en'` row for the same event.

### Manual verification

1. Without whisper installed: upload an MP3, run `/plannen-write-story` — story generates, no error, audio not in narrative.
2. Install `brew install whisper-cpp`, download `ggml-base.en.bin`, re-run — story includes audio context.
3. Configure `[en, nl]` in /settings, run `/plannen-write-story` — two rows in `stories` with same `story_group_id`, different `language`.
4. Open the story in the web app — language pills show; switching pill navigates to NL sibling.
5. `/plannen-doctor` lists whisper-cli + model checks correctly across the four states (installed+model / installed+no-model / not-installed / disabled).

### Regression

- Single-language users see no UI or workflow change.
- Existing stories (pre-migration) have `language='en'` and unique `story_group_id` — they render in the My Stories list exactly as before.
- Image-only events still produce one story per language with no transcript step.

## Open questions

None blocking. Two notes for implementation:

- **Whisper model choice.** `ggml-base.en.bin` (~150 MB) is the recommended default. If users complain about non-English transcript quality we can swap the bootstrap default to `ggml-base.bin` (multilingual, slightly worse English) or `ggml-medium.bin` (better, ~1.5 GB). Not load-bearing for the design.
- **Translation model.** Anthropic Sonnet 4.6 is the default. If translation quality is poor we can switch to per-language prompting (one model call per language) instead of asking for all translations in one prompt. The MCP `create_story` shape doesn't change either way.

## What lands later (deferred)

- Cloud transcription fallback (OpenAI Whisper or Gemini) for users who don't want to install whisper.cpp.
- Backfill: a `/plannen-translate-story <id> <lang>` command to add a sibling translation to an existing story.
- Better whisper model management UI in `/settings` (download progress, switch models).
- Sibling-aware delete: confirm "delete all 3 language versions?" with one click.
- Auto-language for transcripts: detect each speaker segment's language, store per-segment timestamps.
