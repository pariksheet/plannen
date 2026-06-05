# Audio transcription + multi-language stories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional host-side whisper.cpp transcription for audio memories, and per-event multi-language story generation (≤3 languages) with a per-call subset prompt.

**Architecture:** One migration adds `event_memories.transcript*` and `stories.{language, story_group_id}` plus `user_profiles.story_languages`. A new MCP tool `transcribe_memory` shells out to `whisper-cli` and returns `whisper_not_installed` cleanly so callers degrade silently. `create_story` gains `language` + `story_group_id`; single-event overwrite scopes by `(event, language)`. Web Settings adds a multi-select. Plugin's stories skill calls transcribe_memory before composing, asks the user which configured languages to generate this run, then composes canonical + translates.

**Tech Stack:** Postgres migration (Supabase), TypeScript MCP server (Node + child_process), Vitest, React + Vite frontend, Bash bootstrap script, whisper.cpp.

**Spec:** `docs/superpowers/specs/2026-05-10-audio-transcription-multilang-stories-design.md`

---

## File Structure

**Created**
- `supabase/migrations/20260510000000_audio_transcript_and_story_lang.sql` — new columns and constraints
- `mcp/src/transcribe.ts` — whisper-cli integration (spawn, parse, idempotency)
- `mcp/src/transcribe.test.ts` — vitest unit tests for parsing helpers
- `src/utils/storyLanguages.ts` — curated language list + validation
- `src/utils/storyLanguages.test.ts` — list + validation tests

**Modified**
- `mcp/src/index.ts` — register `transcribe_memory`, `get_story_languages`, `set_story_languages`; update `create_story` (language scoping); update `list_event_memories` and `get_story` selects
- `src/types/story.ts` — add `language`, `story_group_id`, `siblings`
- `src/services/storyService.ts` — return siblings from `get_story`
- `src/services/memoryService.ts` (or whichever exposes `Memory`) — add transcript fields
- `src/services/profileService.ts` — `getStoryLanguages`, `setStoryLanguages`
- `src/components/Settings.tsx` — story languages card
- `src/components/StoryReader.tsx` — sibling language pills above title
- `src/hooks/useStory.ts` — typings flow through unchanged (returns siblings via service)
- `scripts/bootstrap.sh` — optional whisper-cpp install step + model download
- `plugin/skills/plannen-stories.md` — transcribe + language-subset prompt + per-language create_story
- `plugin/commands/plannen-doctor.md` — add whisper-cli + model checks
- `.env.example` — document `PLANNEN_WHISPER_MODEL`

---

## Pre-flight

- [ ] **Step 0a: Backup**

```bash
bash scripts/export-seed.sh
ls -lh supabase/seed.sql supabase/seed-photos.tar.gz
```

Expected: both files exist, sizes match the most recent values from before.

- [ ] **Step 0b: Confirm clean working tree on the right branch**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: clean tree, branch `feat/tier-1-opensource`.

---

## Task 1: Migration

**Files:**
- Create: `supabase/migrations/20260510000000_audio_transcript_and_story_lang.sql`

- [ ] **Step 1a: Write the migration**

```sql
-- supabase/migrations/20260510000000_audio_transcript_and_story_lang.sql
--
-- Two related additions:
--   1) event_memories.transcript / transcript_lang / transcribed_at
--      Captures host-side whisper.cpp output for audio rows. caption stays
--      user-editable; transcript is auto and optional.
--   2) stories.language and stories.story_group_id
--      Adds per-language stories. Translations sharing a logical "story" share
--      story_group_id so the UI can show language pills.
--   3) user_profiles.story_languages
--      Up to three preferred languages, ordered (first = canonical).

-- 1. event_memories
ALTER TABLE public.event_memories
  ADD COLUMN transcript      TEXT,
  ADD COLUMN transcript_lang TEXT,
  ADD COLUMN transcribed_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.event_memories.transcript IS
  'Auto-generated transcript from whisper.cpp for audio memories. NULL means not yet '
  'transcribed (or whisper not installed when the user invoked story generation). '
  'caption remains the user-editable field.';

-- 2. stories — language + group id
ALTER TABLE public.stories
  ADD COLUMN language       TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN story_group_id UUID NOT NULL DEFAULT uuid_generate_v4();

CREATE INDEX IF NOT EXISTS stories_group_idx
  ON public.stories(story_group_id);

CREATE INDEX IF NOT EXISTS stories_user_lang_generated_idx
  ON public.stories(user_id, language, generated_at DESC);

-- 3. user_profiles — story_languages with constraints
ALTER TABLE public.user_profiles
  ADD COLUMN story_languages TEXT[] NOT NULL DEFAULT '{en}';

ALTER TABLE public.user_profiles
  ADD CONSTRAINT story_languages_max_3
    CHECK (array_length(story_languages, 1) <= 3);

ALTER TABLE public.user_profiles
  ADD CONSTRAINT story_languages_nonempty
    CHECK (array_length(story_languages, 1) >= 1);
```

- [ ] **Step 1b: Apply the migration**

```bash
supabase migration up
```

Expected: `Applying migration 20260510000000_audio_transcript_and_story_lang.sql...`. No errors.

- [ ] **Step 1c: Verify the schema**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "\d event_memories" | grep -E "transcript|transcribed_at"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "\d stories" | grep -E "language|story_group_id"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "\d user_profiles" | grep story_languages
```

Expected: each grep prints the new column lines.

- [ ] **Step 1d: Verify existing rows backfilled**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT count(*), count(DISTINCT story_group_id) FROM stories;"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT user_id, story_languages FROM user_profiles;"
```

Expected: `count == count(DISTINCT story_group_id)` (every existing story is its own group); story_languages prints `{en}` for every existing profile.

- [ ] **Step 1e: Refresh seed**

```bash
bash scripts/export-seed.sh
```

- [ ] **Step 1f: Commit**

```bash
git add supabase/migrations/20260510000000_audio_transcript_and_story_lang.sql supabase/seed.sql
git commit -m "feat(db): add transcript columns + per-language stories

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: storyLanguages utility (frontend shared)

**Files:**
- Create: `src/utils/storyLanguages.ts`
- Test:   `src/utils/storyLanguages.test.ts`

- [ ] **Step 2a: Write failing test**

```ts
// src/utils/storyLanguages.test.ts
import { describe, expect, it } from 'vitest'
import { STORY_LANGUAGES, isValidLangCode, validateStoryLanguages } from './storyLanguages'

describe('STORY_LANGUAGES', () => {
  it('contains 12 curated entries with code+label', () => {
    expect(STORY_LANGUAGES.length).toBe(12)
    for (const l of STORY_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2}$/)
      expect(l.label.length).toBeGreaterThan(0)
    }
  })

  it('starts with English and includes nl, fr, hi, mr', () => {
    expect(STORY_LANGUAGES[0].code).toBe('en')
    const codes = STORY_LANGUAGES.map(l => l.code)
    for (const c of ['nl', 'fr', 'hi', 'mr']) expect(codes).toContain(c)
  })
})

describe('isValidLangCode', () => {
  it('accepts curated codes', () => {
    expect(isValidLangCode('en')).toBe(true)
    expect(isValidLangCode('nl')).toBe(true)
  })
  it('rejects unknown codes and bad shapes', () => {
    expect(isValidLangCode('xx')).toBe(false)
    expect(isValidLangCode('en-US')).toBe(false)
    expect(isValidLangCode('')).toBe(false)
  })
})

describe('validateStoryLanguages', () => {
  it('accepts a 1–3 entry list of valid codes', () => {
    expect(validateStoryLanguages(['en'])).toEqual({ ok: true, value: ['en'] })
    expect(validateStoryLanguages(['en', 'nl', 'fr'])).toEqual({ ok: true, value: ['en', 'nl', 'fr'] })
  })
  it('rejects empty list', () => {
    expect(validateStoryLanguages([])).toEqual({ ok: false, error: 'At least one language is required.' })
  })
  it('rejects more than 3', () => {
    expect(validateStoryLanguages(['en', 'nl', 'fr', 'de'])).toEqual({ ok: false, error: 'Maximum 3 languages.' })
  })
  it('rejects unknown codes', () => {
    expect(validateStoryLanguages(['en', 'xx'])).toEqual({ ok: false, error: 'Unknown language: xx' })
  })
  it('dedupes while preserving order', () => {
    expect(validateStoryLanguages(['en', 'nl', 'en'])).toEqual({ ok: true, value: ['en', 'nl'] })
  })
})
```

- [ ] **Step 2b: Run test (expect failures)**

```bash
npm test -- src/utils/storyLanguages.test.ts
```

Expected: FAIL — `Cannot find module './storyLanguages'`.

- [ ] **Step 2c: Implement**

```ts
// src/utils/storyLanguages.ts
export interface StoryLanguage { code: string; label: string }

export const STORY_LANGUAGES: StoryLanguage[] = [
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

const VALID_CODES = new Set(STORY_LANGUAGES.map(l => l.code))

export function isValidLangCode(code: string): boolean {
  return VALID_CODES.has(code)
}

export type ValidateResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string }

export function validateStoryLanguages(input: readonly string[]): ValidateResult {
  if (input.length === 0) return { ok: false, error: 'At least one language is required.' }
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of input) {
    if (!isValidLangCode(c)) return { ok: false, error: `Unknown language: ${c}` }
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  if (out.length > 3) return { ok: false, error: 'Maximum 3 languages.' }
  return { ok: true, value: out }
}

export function labelFor(code: string): string {
  return STORY_LANGUAGES.find(l => l.code === code)?.label ?? code.toUpperCase()
}
```

- [ ] **Step 2d: Run test (expect pass)**

```bash
npm test -- src/utils/storyLanguages.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 2e: Commit**

```bash
git add src/utils/storyLanguages.ts src/utils/storyLanguages.test.ts
git commit -m "feat(stories): curated story language list + validator

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: profileService — getStoryLanguages / setStoryLanguages

**Files:**
- Modify: `src/services/profileService.ts`

- [ ] **Step 3a: Add the functions**

Append to `src/services/profileService.ts`:

```ts
import { validateStoryLanguages } from '../utils/storyLanguages'

export async function getStoryLanguages(): Promise<{ data: string[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: ['en'], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('story_languages')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return { data: ['en'], error: new Error(error.message) }
  const langs = (data?.story_languages as string[] | null | undefined) ?? ['en']
  return { data: langs.length ? langs : ['en'], error: null }
}

export async function setStoryLanguages(input: readonly string[]): Promise<{ error: Error | null }> {
  const result = validateStoryLanguages(input)
  if (!result.ok) return { error: new Error(result.error) }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, story_languages: result.value }, { onConflict: 'user_id' })
  return { error: error ? new Error(error.message) : null }
}
```

- [ ] **Step 3b: Verify type-check**

```bash
npm run build || npx tsc --noEmit
```

Expected: zero TypeScript errors.

- [ ] **Step 3c: Commit**

```bash
git add src/services/profileService.ts
git commit -m "feat(profile): get/setStoryLanguages helpers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Settings UI — Story languages card

**Files:**
- Modify: `src/components/Settings.tsx`

- [ ] **Step 4a: Add state and load on mount**

Open `src/components/Settings.tsx`. Inside the `Settings` component, after the existing `useEffect` that hydrates from `settings`, add:

```ts
const [storyLangs, setStoryLangs] = useState<string[]>(['en'])
const [langSaving, setLangSaving] = useState(false)
const [langSaved, setLangSaved] = useState(false)
const [langError, setLangError] = useState<string | null>(null)

useEffect(() => {
  let cancelled = false
  void getStoryLanguages().then(({ data }) => {
    if (!cancelled) setStoryLangs(data)
  })
  return () => { cancelled = true }
}, [])
```

Add the imports at the top of the file:

```ts
import { getStoryLanguages, setStoryLanguages } from '../services/profileService'
import { STORY_LANGUAGES, labelFor } from '../utils/storyLanguages'
```

- [ ] **Step 4b: Add toggle + save handler**

Below `handleClear`, add:

```ts
const toggleLang = (code: string) => {
  setLangSaved(false)
  setLangError(null)
  setStoryLangs(prev => {
    if (prev.includes(code)) return prev.filter(c => c !== code)
    if (prev.length >= 3) return prev      // hard cap, silent
    return [...prev, code]
  })
}

const handleLangSave = async () => {
  setLangSaving(true)
  setLangError(null)
  setLangSaved(false)
  const { error } = await setStoryLanguages(storyLangs)
  setLangSaving(false)
  if (error) setLangError(error.message)
  else { setLangSaved(true); setTimeout(() => setLangSaved(false), 2000) }
}
```

- [ ] **Step 4c: Render the card**

In the JSX, just before the closing `</div>` of `<div className="max-w-xl mx-auto py-8 px-4">`, add:

```tsx
<div className="mt-6 bg-white rounded-lg border border-gray-200 p-5">
  <div className="flex items-center gap-2 mb-1">
    <span className="text-sm font-medium text-gray-700">Story languages</span>
    {langSaved && (
      <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
        <CheckCircle className="h-3.5 w-3.5" /> Saved
      </span>
    )}
  </div>
  <p className="text-xs text-gray-500 mb-3">
    Stories are generated in your selected languages (max 3). The first selected language is the canonical one — translations are made from it.
  </p>

  <div className="flex flex-wrap gap-2">
    {STORY_LANGUAGES.map(({ code, label }) => {
      const active = storyLangs.includes(code)
      const idx = storyLangs.indexOf(code)
      const disabled = !active && storyLangs.length >= 3
      return (
        <button
          key={code}
          type="button"
          onClick={() => toggleLang(code)}
          disabled={disabled}
          className={
            active
              ? 'px-3 py-1.5 rounded-full text-sm border border-indigo-500 bg-indigo-50 text-indigo-700'
              : 'px-3 py-1.5 rounded-full text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40'
          }
        >
          {active && <span className="mr-1 text-xs font-mono">{idx + 1}</span>}
          {label}
        </button>
      )
    })}
  </div>

  <p className="text-xs text-gray-500 mt-3">
    Selected order: {storyLangs.map(labelFor).join(', ')}
  </p>

  <div className="flex gap-2 pt-3">
    <button
      type="button"
      onClick={handleLangSave}
      disabled={langSaving}
      className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
    >
      {langSaving ? 'Saving…' : 'Save languages'}
    </button>
  </div>

  {langError && <p className="mt-3 text-xs text-red-600">{langError}</p>}
</div>
```

- [ ] **Step 4d: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4e: Manual smoke (start dev server)**

```bash
npm run dev
```

Then in the browser at `http://localhost:5173/settings`:
1. The new "Story languages" card renders below the AI key card.
2. English is preselected.
3. Click Nederlands and Français — both light up; numeric badges show `1 2 3`.
4. Try a fourth — it stays disabled (greyed out).
5. Click Save languages — green "Saved" appears, fades after 2s.
6. Refresh the page — selection persists.

Expected: all six observations match.

Stop the dev server before continuing (Ctrl+C).

- [ ] **Step 4f: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat(settings): story languages multi-select

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Memory type — transcript fields

**Files:**
- Modify: `src/services/memoryService.ts` (or wherever the Memory interface lives)

- [ ] **Step 5a: Locate the Memory interface**

```bash
grep -rn "media_url" src/services/ src/types/ --include="*.ts" | head
```

The `Memory` interface lives at `src/services/memoryService.ts`. (If grep shows otherwise, edit the file that grep returns.)

- [ ] **Step 5b: Add the new fields**

In the `Memory` interface (or `MemoryRow`/equivalent type):

```ts
export interface Memory {
  // … existing fields …
  transcript: string | null
  transcript_lang: string | null
  transcribed_at: string | null
}
```

If a `select('id, ...')` string in the same file enumerates columns explicitly, append `, transcript, transcript_lang, transcribed_at`.

- [ ] **Step 5c: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5d: Commit**

```bash
git add src/services/memoryService.ts
git commit -m "feat(memories): expose transcript fields on Memory type

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Story type — language + siblings

**Files:**
- Modify: `src/types/story.ts`
- Modify: `src/services/storyService.ts`

- [ ] **Step 6a: Update Story interface**

Replace `src/types/story.ts` with:

```ts
export interface StoryEventLink {
  id: string
  title: string | null
  start_date: string | null
}

export interface Story {
  id: string
  user_id: string
  story_group_id: string
  language: string
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

export interface StorySibling {
  id: string
  language: string
}

export interface StoryWithEvents extends Story {
  events: StoryEventLink[]
}

export interface StoryWithEventsAndSiblings extends StoryWithEvents {
  siblings: StorySibling[]
}
```

- [ ] **Step 6b: Update storyService.getStory to fetch siblings**

In `src/services/storyService.ts`:

Replace the `getStory` function with:

```ts
export async function getStory(id: string): Promise<StoryWithEventsAndSiblings | null> {
  const { data, error } = await supabase
    .from('stories')
    .select('*, story_events(events:event_id(id, title, start_date))')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const flat = flattenEvents(data as unknown as RawStoryRow)
  // Fetch sibling translations (same group, all languages including self)
  const { data: sibs, error: sibErr } = await supabase
    .from('stories')
    .select('id, language')
    .eq('story_group_id', flat.story_group_id)
    .order('generated_at', { ascending: true })
  if (sibErr) throw sibErr
  return { ...flat, siblings: (sibs ?? []) as StorySibling[] }
}
```

Update the import to include `StorySibling, StoryWithEventsAndSiblings`:

```ts
import type { Story, StoryWithEvents, StoryEventLink, StorySibling, StoryWithEventsAndSiblings } from '../types/story'
```

(Keep the rest of `storyService.ts` unchanged.)

- [ ] **Step 6c: Update useStory hook typing**

In `src/hooks/useStory.ts`, change the import + state type from `StoryWithEvents` to `StoryWithEventsAndSiblings`:

```ts
import type { StoryWithEventsAndSiblings } from '../types/story'

export function useStory(id: string | undefined) {
  const [story, setStory] = useState<StoryWithEventsAndSiblings | null>(null)
  // … rest unchanged
```

- [ ] **Step 6d: Type-check + run web tests**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: zero TS errors. Existing story tests still pass (the new field is additive).

- [ ] **Step 6e: Commit**

```bash
git add src/types/story.ts src/services/storyService.ts src/hooks/useStory.ts
git commit -m "feat(stories): language + sibling translations on Story type

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: StoryReader — sibling language pills

**Files:**
- Modify: `src/components/StoryReader.tsx`

- [ ] **Step 7a: Render pills above the title**

Add this import at the top of `src/components/StoryReader.tsx`:

```ts
import { labelFor } from '../utils/storyLanguages'
import { Link } from 'react-router-dom'
```

Inside the JSX, just before the `<div className="mt-3 flex items-start justify-between gap-3">` line that wraps the title, insert:

```tsx
{story.siblings.length > 1 && (
  <div className="flex items-center gap-2 mt-3 flex-wrap" aria-label="Story translations">
    <span className="text-xs uppercase tracking-wide text-gray-500">Languages:</span>
    {story.siblings.map(s => {
      const active = s.id === story.id
      return active ? (
        <span
          key={s.id}
          className="px-2 py-0.5 rounded-full text-xs border border-indigo-500 bg-indigo-50 text-indigo-700"
          aria-current="page"
        >
          {labelFor(s.language)}
        </span>
      ) : (
        <Link
          key={s.id}
          to={`/stories/${s.id}`}
          className="px-2 py-0.5 rounded-full text-xs border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          {labelFor(s.language)}
        </Link>
      )
    })}
  </div>
)}
```

- [ ] **Step 7b: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7c: Manual smoke (deferred — needs Task 8 backend support to actually have siblings)**

We'll verify after Task 8. For now, confirm the existing single-language story still renders cleanly:

```bash
npm run dev
```

Visit any existing story at `/stories/<id>`. Expected: pills row absent (only 1 sibling), rest of page unchanged. Stop dev server.

- [ ] **Step 7d: Commit**

```bash
git add src/components/StoryReader.tsx
git commit -m "feat(stories): sibling language pills in StoryReader

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: MCP — list_event_memories returns transcript

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 8a: Update select + tool description**

Find `listEventMemories` (around line 320 of `mcp/src/index.ts`). Change the select to include transcript fields:

```ts
.select('id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at')
```

Find the `list_event_memories` tool registration (around line 1375) and update the description:

```
description: 'List memories attached to an event, ordered by taken_at ASC (NULLS LAST), then created_at ASC. Returns id, event_id, media_url, media_type, caption, taken_at, created_at, external_id, source, transcript, transcript_lang, transcribed_at. The transcript field is populated for audio memories that have been transcribed via transcribe_memory; null otherwise. Use it for story context.',
```

- [ ] **Step 8b: Build MCP**

```bash
cd mcp && npm run build && cd ..
```

Expected: build succeeds.

- [ ] **Step 8c: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): list_event_memories returns transcript fields

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: MCP — transcribe.ts module + tests

**Files:**
- Create: `mcp/src/transcribe.ts`
- Create: `mcp/src/transcribe.test.ts`

- [ ] **Step 9a: Write failing test for parseDetectedLanguage**

```ts
// mcp/src/transcribe.test.ts
import { describe, expect, it } from 'vitest'
import { parseDetectedLanguage, extFromContentType } from './transcribe.js'

describe('parseDetectedLanguage', () => {
  it('extracts language code from whisper-cli stderr', () => {
    const stderr = `whisper_full_with_state: auto-detected language: nl (p = 0.987654)\n`
    expect(parseDetectedLanguage(stderr)).toBe('nl')
  })
  it('handles English detection', () => {
    expect(parseDetectedLanguage('auto-detected language: en (p = 0.99)')).toBe('en')
  })
  it('returns null when not present', () => {
    expect(parseDetectedLanguage('no language line here')).toBe(null)
    expect(parseDetectedLanguage('')).toBe(null)
  })
  it('handles multiple lines and matches the first', () => {
    const s = 'log line\nauto-detected language: fr (p = 0.5)\nauto-detected language: de (p = 0.4)'
    expect(parseDetectedLanguage(s)).toBe('fr')
  })
})

describe('extFromContentType', () => {
  it('maps common audio MIMEs to extensions', () => {
    expect(extFromContentType('audio/mpeg')).toBe('mp3')
    expect(extFromContentType('audio/mp4')).toBe('m4a')
    expect(extFromContentType('audio/x-m4a')).toBe('m4a')
    expect(extFromContentType('audio/wav')).toBe('wav')
    expect(extFromContentType('audio/ogg')).toBe('ogg')
  })
  it('returns null for unknown types', () => {
    expect(extFromContentType('application/pdf')).toBe(null)
    expect(extFromContentType(undefined)).toBe(null)
  })
})
```

- [ ] **Step 9b: Run test (expect failure)**

```bash
cd mcp && npm test -- transcribe.test.ts
```

Expected: FAIL — `Cannot find module './transcribe.js'`.

- [ ] **Step 9c: Implement transcribe.ts**

```ts
// mcp/src/transcribe.ts
import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_MODEL = `${process.env.HOME ?? ''}/.plannen/whisper/ggml-base.en.bin`

export function modelPath(): string {
  return process.env.PLANNEN_WHISPER_MODEL && process.env.PLANNEN_WHISPER_MODEL !== 'disabled'
    ? process.env.PLANNEN_WHISPER_MODEL
    : DEFAULT_MODEL
}

export function isDisabled(): boolean {
  return process.env.PLANNEN_WHISPER_MODEL === 'disabled'
}

export function parseDetectedLanguage(stderr: string): string | null {
  const m = stderr.match(/auto-detected language:\s*([a-z]{2})\b/i)
  return m ? m[1].toLowerCase() : null
}

export function extFromContentType(ct: string | undefined): string | null {
  if (!ct) return null
  const lower = ct.split(';')[0].trim().toLowerCase()
  switch (lower) {
    case 'audio/mpeg':   return 'mp3'
    case 'audio/mp3':    return 'mp3'
    case 'audio/mp4':    return 'm4a'
    case 'audio/x-m4a':  return 'm4a'
    case 'audio/aac':    return 'aac'
    case 'audio/wav':    return 'wav'
    case 'audio/x-wav':  return 'wav'
    case 'audio/ogg':    return 'ogg'
    case 'audio/webm':   return 'webm'
    case 'audio/flac':   return 'flac'
    default:             return null
  }
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { stdio: 'ignore', shell: true })
    child.on('exit', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export async function whisperAvailable(): Promise<boolean> {
  if (isDisabled()) return false
  return await commandExists('whisper-cli')
}

interface RunResult { stdout: string; stderr: string; code: number | null }

function runCmd(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args)
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve({ stdout, stderr, code }))
    child.on('error', err => resolve({ stdout, stderr: stderr + String(err), code: -1 }))
  })
}

async function safeUnlink(...paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p) } catch { /* ignore */ }
  }
}

export async function transcribeAudioBytes(
  bytes: Uint8Array,
  hint: { contentType?: string; ext?: string } = {},
): Promise<{ transcript: string; language: string }> {
  const ext = hint.ext ?? extFromContentType(hint.contentType) ?? 'm4a'
  const base = join(tmpdir(), `plannen-${randomUUID()}`)
  const inputPath = `${base}.${ext}`
  const txtPath = `${inputPath}.txt`   // whisper-cli writes <input>.txt with -otxt

  await writeFile(inputPath, bytes)
  const args = ['-m', modelPath(), '-f', inputPath, '-otxt', '-l', 'auto', '-nt']
  const { stderr, code } = await runCmd('whisper-cli', args)
  if (code !== 0) {
    await safeUnlink(inputPath, txtPath)
    throw new Error(`whisper-cli exited ${code ?? 'null'}: ${stderr.slice(-500)}`)
  }
  let transcript = ''
  try { transcript = (await readFile(txtPath, 'utf8')).trim() }
  catch (e) {
    await safeUnlink(inputPath, txtPath)
    throw new Error(`whisper-cli produced no transcript file: ${e instanceof Error ? e.message : String(e)}`)
  }
  const language = parseDetectedLanguage(stderr) ?? 'en'
  await safeUnlink(inputPath, txtPath)
  return { transcript, language }
}
```

- [ ] **Step 9d: Update tsconfig if needed**

If `mcp/tsconfig.json` doesn't include `*.test.ts`, no change needed (tests are run via vitest, not tsc).

- [ ] **Step 9e: Run tests (expect pass)**

```bash
cd mcp && npm test -- transcribe.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 9f: Build MCP**

```bash
cd mcp && npm run build
```

Expected: build succeeds. Return to repo root: `cd ..`.

- [ ] **Step 9g: Commit**

```bash
git add mcp/src/transcribe.ts mcp/src/transcribe.test.ts
git commit -m "feat(mcp): whisper.cpp shell-out + parsers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: MCP — transcribe_memory tool

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 10a: Add the import + handler near other handlers**

At the top of `mcp/src/index.ts`, after the `recurrence` import, add:

```ts
import { whisperAvailable, transcribeAudioBytes, extFromContentType } from './transcribe.js'
```

After the `listEventMemories` function (around line 337), add:

```ts
async function transcribeMemory(args: { memory_id: string; force?: boolean }) {
  await uid() // ensure auth scope (also throws on missing user)
  const { data: row, error } = await db
    .from('event_memories')
    .select('id, media_type, media_url, transcript, transcript_lang')
    .eq('id', args.memory_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!row) throw new Error('memory not found')
  if (row.media_type !== 'audio') {
    return { ok: false as const, error: 'unsupported_media_type', detail: `media_type=${row.media_type}` }
  }
  if (row.transcript && !args.force) {
    return {
      ok: true as const, cached: true,
      transcript: row.transcript,
      language: row.transcript_lang ?? 'en',
    }
  }
  if (!await whisperAvailable()) {
    return { ok: false as const, error: 'whisper_not_installed' }
  }
  if (!row.media_url) {
    return { ok: false as const, error: 'fetch_failed', detail: 'media_url is null' }
  }

  let bytes: Uint8Array
  let contentType: string | undefined
  try {
    const res = await fetch(row.media_url)
    if (!res.ok) return { ok: false as const, error: 'fetch_failed', detail: `HTTP ${res.status}` }
    contentType = res.headers.get('content-type') ?? undefined
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    return { ok: false as const, error: 'fetch_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  let transcript: string, language: string
  try {
    const out = await transcribeAudioBytes(bytes, { contentType, ext: extFromContentType(contentType) ?? undefined })
    transcript = out.transcript; language = out.language
  } catch (e) {
    return { ok: false as const, error: 'whisper_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  const { error: updErr } = await db
    .from('event_memories')
    .update({ transcript, transcript_lang: language, transcribed_at: new Date().toISOString() })
    .eq('id', args.memory_id)
  if (updErr) throw new Error(updErr.message)

  return { ok: true as const, cached: false, transcript, language }
}
```

- [ ] **Step 10b: Register the tool**

In the `tools` array (around the `list_event_memories` registration, line ~1375), add a new entry:

```ts
{
  name: 'transcribe_memory',
  description: 'Transcribe an audio event_memory using a host-side whisper.cpp install (the `whisper-cli` binary on PATH). Reads the audio bytes from the storage URL, spawns whisper-cli, parses the result, and persists transcript + transcript_lang on the row. Idempotent — returns the existing transcript without re-running if already populated. Returns { ok: false, error: "whisper_not_installed" } if whisper-cli is not on PATH so callers can degrade gracefully (no error popup). Image and video rows return error "unsupported_media_type". Use this from the stories skill before composing, once per audio memory.',
  inputSchema: {
    type: 'object',
    properties: {
      memory_id: { type: 'string' },
      force:     { type: 'boolean', description: 'Re-transcribe even if a transcript already exists' },
    },
    required: ['memory_id'],
  },
},
```

In the dispatcher `switch` (around line 1710), add:

```ts
case 'transcribe_memory': result = await transcribeMemory(args as Parameters<typeof transcribeMemory>[0]); break
```

- [ ] **Step 10c: Build**

```bash
cd mcp && npm run build && cd ..
```

Expected: build succeeds.

- [ ] **Step 10d: Smoke-test the not-installed path**

If you do not have `whisper-cli` on PATH yet (likely), the tool should return `whisper_not_installed`. Pick any existing audio memory id (or create one by uploading an audio file in the web app):

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -c \
  "SELECT id FROM event_memories WHERE media_type='audio' LIMIT 1;"
```

If the result is empty, skip this smoke (we'll re-test in Task 14). If you have an id, restart Claude Code MCP (`/mcp` reconnect plannen) and call `mcp__plannen__transcribe_memory({memory_id: '<id>'})` from a chat — expected response shape: `{ ok: false, error: 'whisper_not_installed' }` (or `{ ok: true, cached: true, ... }` if the row already has a transcript).

- [ ] **Step 10e: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): transcribe_memory tool with graceful whisper-not-installed

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: MCP — get_story_languages + set_story_languages

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 11a: Add handlers**

After the `updateProfile` function in `mcp/src/index.ts`, add:

```ts
async function getStoryLanguagesHandler() {
  const id = await uid()
  const { data, error } = await db
    .from('user_profiles')
    .select('story_languages')
    .eq('user_id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const langs = (data?.story_languages as string[] | null | undefined) ?? ['en']
  return { languages: langs.length ? langs : ['en'] }
}

const ALLOWED_LANG_CODES = new Set(['en','nl','fr','de','es','it','pt','hi','mr','ja','zh','ar'])

async function setStoryLanguagesHandler(args: { languages: string[] }) {
  if (!Array.isArray(args.languages) || args.languages.length === 0) {
    throw new Error('languages must be a non-empty array')
  }
  if (args.languages.length > 3) throw new Error('Maximum 3 languages.')
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const c of args.languages) {
    if (!ALLOWED_LANG_CODES.has(c)) throw new Error(`Unknown language: ${c}`)
    if (!seen.has(c)) { seen.add(c); cleaned.push(c) }
  }
  const id = await uid()
  const { error } = await db
    .from('user_profiles')
    .upsert({ user_id: id, story_languages: cleaned }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return { languages: cleaned }
}
```

- [ ] **Step 11b: Register the tools**

In the `tools` array, near `update_profile`, add:

```ts
{
  name: 'get_story_languages',
  description: 'Return the user\'s configured story languages from user_profiles.story_languages. Order matters — the first entry is the canonical language used for the initial composition; subsequent entries are translations. Always returns at least one language ("en" default).',
  inputSchema: { type: 'object', properties: {}, required: [] },
},
{
  name: 'set_story_languages',
  description: 'Set the user\'s configured story languages (1–3, ordered, codes from: en, nl, fr, de, es, it, pt, hi, mr, ja, zh, ar). Order is preserved; the first entry is canonical.',
  inputSchema: {
    type: 'object',
    properties: {
      languages: { type: 'array', items: { type: 'string' } },
    },
    required: ['languages'],
  },
},
```

In the dispatcher `switch`, add:

```ts
case 'get_story_languages': result = await getStoryLanguagesHandler(); break
case 'set_story_languages': result = await setStoryLanguagesHandler(args as Parameters<typeof setStoryLanguagesHandler>[0]); break
```

- [ ] **Step 11c: Build + smoke**

```bash
cd mcp && npm run build && cd ..
```

Reconnect MCP in Claude Code (`/mcp`), then call `mcp__plannen__get_story_languages({})`. Expected: `{ languages: ['en'] }` (or whatever you saved in Task 4f).

- [ ] **Step 11d: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): get_story_languages + set_story_languages tools

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: MCP — create_story language scoping + get_story siblings

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 12a: Update createStory args type and overwrite scope**

Find `createStory` (around line 339). Update the args type:

```ts
async function createStory(args: {
  event_ids?: string[]
  title: string
  body: string
  user_notes?: string
  mood?: string
  tone?: string
  cover_url?: string
  date_from?: string
  date_to?: string
  language?: string                    // NEW
  story_group_id?: string              // NEW
}) {
```

Where the existing-story lookup happens (the `eventIds.length === 1` block, around line 369), update the existing-row query to scope by language too:

```ts
if (eventIds.length === 1) {
  const lang = args.language ?? 'en'
  const { data: existing } = await db
    .from('story_events')
    .select('story_id, stories!inner(id, user_id, language)')
    .eq('event_id', eventIds[0])
    .eq('stories.user_id', userId)
    .eq('stories.language', lang)
    .maybeSingle()
  if (existing?.story_id) {
    const updatePatch: Record<string, unknown> = {
      title: args.title,
      body: args.body,
      user_notes: args.user_notes ?? null,
      mood: args.mood ?? null,
      tone: args.tone ?? null,
      generated_at: new Date().toISOString(),
    }
    if (args.cover_url !== undefined) updatePatch.cover_url = args.cover_url
    const { data, error } = await db
      .from('stories')
      .update(updatePatch)
      .eq('id', existing.story_id)
      .select('id, story_group_id, language')
      .single()
    if (error) throw new Error(error.message)
    return { id: data.id, story_group_id: data.story_group_id, language: data.language, overwritten: true }
  }
}
```

Update the insert payload (around line 411) to include language and group:

```ts
const insertPayload: Record<string, unknown> = {
  user_id: userId,
  title: args.title,
  body: args.body,
  cover_url: coverUrl,
  user_notes: args.user_notes ?? null,
  mood: args.mood ?? null,
  tone: args.tone ?? null,
  date_from: args.date_from ?? null,
  date_to: args.date_to ?? null,
  language: args.language ?? 'en',
}
if (args.story_group_id) insertPayload.story_group_id = args.story_group_id

const { data: story, error: insErr } = await db
  .from('stories')
  .insert(insertPayload)
  .select('id, story_group_id, language')
  .single()
if (insErr) throw new Error(insErr.message)

if (eventIds.length) {
  const links = eventIds.map(event_id => ({ story_id: story.id, event_id }))
  const { error: linkErr } = await db.from('story_events').insert(links)
  if (linkErr) throw new Error(linkErr.message)
}

return { id: story.id, story_group_id: story.story_group_id, language: story.language, overwritten: false }
```

- [ ] **Step 12b: Update create_story tool description + schema**

In the `create_story` tool registration (around line 1386):

```ts
{
  name: 'create_story',
  description: 'Create (or overwrite, if event_ids has length 1 and a story already exists for that event AT THE SAME LANGUAGE) an AI-generated story. Pass language to write a non-English story (default "en"). Pass story_group_id to link this row as a translation of an existing story group — siblings sharing a story_group_id render as language pills in the UI. Single-event overwrite is now scoped by (event, language); generating an EN story for event X does NOT overwrite the NL one. cover_url defaults to the first IMAGE memory by taken_at across linked events.',
  inputSchema: {
    type: 'object',
    properties: {
      event_ids:      { type: 'array', items: { type: 'string' }, description: 'One or more event UUIDs' },
      title:          { type: 'string' },
      body:           { type: 'string', description: 'Markdown allowed' },
      user_notes:     { type: 'string', description: 'Optional reflection from the user' },
      mood:           { type: 'string', description: 'Optional, e.g. "chill", "memorable"' },
      tone:           { type: 'string', description: 'Optional, e.g. "diary", "postcard"' },
      cover_url:      { type: 'string', description: 'Optional override; defaults to first IMAGE memory by taken_at' },
      date_from:      { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
      date_to:        { type: 'string', description: 'YYYY-MM-DD; only used for date-range stories' },
      language:       { type: 'string', description: 'BCP-47 short code, e.g. "en", "nl", "fr". Default "en".' },
      story_group_id: { type: 'string', description: 'UUID; pass when creating a sibling translation of an existing story so they share a group.' },
    },
    required: ['title', 'body'],
  },
},
```

- [ ] **Step 12c: Update getStory and listStories to return new fields**

Find `getStory` (around line 449). Update its select to include `story_group_id, language`, and add a sibling fetch:

```ts
async function getStory(args: { id: string }) {
  const userId = await uid()
  const { data: story, error } = await db
    .from('stories')
    .select('*')
    .eq('id', args.id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!story) return null
  const { data: events } = await db
    .from('story_events')
    .select('events:event_id(id, title, start_date)')
    .eq('story_id', story.id)
  const { data: siblings } = await db
    .from('stories')
    .select('id, language')
    .eq('story_group_id', story.story_group_id)
    .order('generated_at', { ascending: true })
  const eventList = (events ?? []).map(r => r.events).filter(Boolean)
  return { ...story, events: eventList, siblings: siblings ?? [] }
}
```

Update the `get_story` tool description (around line 1419):

```ts
{
  name: 'get_story',
  description: 'Fetch a single story by id, including a small array of linked event summaries (id, title, start_date) and a siblings array [{id, language}] of all translations sharing this story\'s story_group_id (including itself).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
},
```

- [ ] **Step 12d: Build**

```bash
cd mcp && npm run build && cd ..
```

Expected: zero errors.

- [ ] **Step 12e: Smoke-test create + get round trip**

Reconnect MCP in Claude Code (`/mcp`). Pick any test event id with at least one memory:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -c \
  "SELECT id FROM events WHERE created_by = (SELECT id FROM auth.users WHERE email = '$(grep PLANNEN_USER_EMAIL .env | cut -d= -f2)') ORDER BY start_date DESC LIMIT 1;"
```

Note the event id, then call from chat:

```
mcp__plannen__create_story({
  event_ids: ['<id>'], title: 'EN test', body: 'Hello in English.', language: 'en'
})
```

Note the returned `story_group_id`. Then:

```
mcp__plannen__create_story({
  event_ids: ['<id>'], title: 'NL test', body: 'Hallo in het Nederlands.',
  language: 'nl', story_group_id: '<group from previous call>'
})
```

Then `mcp__plannen__get_story({ id: <first id> })` — expected: returns story with `language: 'en'` and `siblings: [{id, language: 'en'}, {id, language: 'nl'}]`.

Verify in DB:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT id, language, story_group_id FROM stories WHERE title IN ('EN test', 'NL test');"
```

Expected: two rows with the same `story_group_id`, different `language`.

Clean up: delete both stories.

```
mcp__plannen__delete_story({ id: '<first>' })
mcp__plannen__delete_story({ id: '<second>' })
```

- [ ] **Step 12f: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): create_story language scoping; get_story returns siblings

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Bootstrap whisper.cpp install + model download

**Files:**
- Modify: `scripts/bootstrap.sh`
- Modify: `.env.example`

- [ ] **Step 13a: Add the optional install step**

Open `scripts/bootstrap.sh`. Find the "Final printout" section (the `step "Done"` line near the bottom). Insert a new step before it:

```bash
# ── 10b. Optional: whisper.cpp for audio transcription in stories ─────────────

step "Optional: whisper.cpp for audio transcription"

WHISPER_MODEL_DIR="$HOME/.plannen/whisper"
WHISPER_MODEL_FILE="$WHISPER_MODEL_DIR/ggml-base.en.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if command -v whisper-cli >/dev/null 2>&1; then
  echo "  whisper-cli already installed at $(command -v whisper-cli)"
else
  cat <<EOF
  Audio memories can be transcribed locally with whisper.cpp. This is OPTIONAL —
  audio uploads + plays without it; the story flow just won't see audio content.

    macOS:  brew install whisper-cpp
    Linux:  build from https://github.com/ggerganov/whisper.cpp

EOF
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    read -r -p "  Install via brew now? [y/N] " yn
    case "$yn" in
      [Yy]*)
        brew install whisper-cpp || dim "  brew install failed — install manually if you want this"
        ;;
      *)
        dim "  Skipped. You can run 'brew install whisper-cpp' later."
        ;;
    esac
  else
    dim "  No brew detected — install manually if you want this."
  fi
fi

if command -v whisper-cli >/dev/null 2>&1; then
  if [ -f "$WHISPER_MODEL_FILE" ]; then
    echo "  Model present at $WHISPER_MODEL_FILE"
  else
    read -r -p "  Download default model (ggml-base.en.bin, ~150 MB) to $WHISPER_MODEL_FILE? [y/N] " yn
    case "$yn" in
      [Yy]*)
        mkdir -p "$WHISPER_MODEL_DIR"
        if command -v curl >/dev/null 2>&1; then
          curl -L --fail -o "$WHISPER_MODEL_FILE" "$WHISPER_MODEL_URL" \
            || dim "  Download failed — fetch manually from $WHISPER_MODEL_URL"
        else
          dim "  curl missing — install curl or fetch manually"
        fi
        ;;
      *)
        dim "  Skipped. Download manually from $WHISPER_MODEL_URL"
        dim "  and place it at $WHISPER_MODEL_FILE (or set PLANNEN_WHISPER_MODEL)."
        ;;
    esac
  fi
fi
```

- [ ] **Step 13b: Document the env var**

Add to `.env.example`:

```sh
# Optional: path to whisper.cpp model file. Defaults to ~/.plannen/whisper/ggml-base.en.bin.
# Set to 'disabled' to opt out of audio transcription even if whisper-cli is installed.
PLANNEN_WHISPER_MODEL=
```

- [ ] **Step 13c: Smoke-test the new bootstrap step (skip-only)**

Run bootstrap and answer `n` to all whisper prompts:

```bash
bash scripts/bootstrap.sh
```

Walk through. When the whisper-cpp prompt appears, answer `n`. Confirm:
- The script prints "Skipped. You can run 'brew install whisper-cpp' later."
- The rest of bootstrap continues normally (existing checks all still pass).

If you DO want to install whisper-cpp now (recommended so you can verify Task 14), say `y` to brew install and `y` to model download. Otherwise the integration tests in Task 17 will exercise only the not-installed path.

- [ ] **Step 13d: Commit**

```bash
git add scripts/bootstrap.sh .env.example
git commit -m "feat(bootstrap): optional whisper.cpp install + model download

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: plannen-doctor — whisper checks

**Files:**
- Modify: `plugin/commands/plannen-doctor.md`

- [ ] **Step 14a: Add two new checks**

Open `plugin/commands/plannen-doctor.md`. After check 8 (AI provider configured) and before check 9 (Google OAuth keys), insert:

```markdown
9. **whisper-cli availability**. Try `command -v whisper-cli`.
   - Pass: present.
   - Warning if missing → `→ brew install whisper-cpp` (mac) or build from https://github.com/ggerganov/whisper.cpp. Story flow will skip audio.
   - Skipped (silent pass) if `PLANNEN_WHISPER_MODEL=disabled` in `.env`.

10. **whisper model file present** (only checked if check 9 passed).
    - Pass: file at `$PLANNEN_WHISPER_MODEL` (or `~/.plannen/whisper/ggml-base.en.bin` if unset) exists.
    - Warning otherwise → `→ download a model: curl -L -o ~/.plannen/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`.
```

Renumber the existing check 9 to 11.

Update the example output to include the new checks. Replace the example block with:

```
✓ .env present at /Users/you/plannen/.env
✓ PLANNEN_USER_EMAIL=you@example.com
✓ Supabase reachable (http://127.0.0.1:54321)
✓ Plannen user exists for you@example.com
✓ MCP build present at mcp/dist/index.js
✓ Plugin installed in Claude Code
✓ Functions-serve running
⚠ Anthropic key not configured
   → web app → /settings
⚠ whisper-cli not installed — audio transcription disabled
   → brew install whisper-cpp
⚠ whisper model file missing at ~/.plannen/whisper/ggml-base.en.bin
   → curl -L -o ~/.plannen/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
✓ Google OAuth keys configured

Summary: 8 ok, 0 hard failures, 3 warnings.
```

- [ ] **Step 14b: Smoke-test**

In Claude Code, run `/plannen-doctor`. Expected: the new check lines appear; if whisper isn't installed, two warnings show; if installed but model missing, one warning shows.

- [ ] **Step 14c: Commit**

```bash
git add plugin/commands/plannen-doctor.md
git commit -m "feat(doctor): check whisper-cli and model file

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: Plugin stories skill — transcribe + multi-language

**Files:**
- Modify: `plugin/skills/plannen-stories.md`

- [ ] **Step 15a: Replace the workflow section**

Replace the entire `## Workflow` section in `plugin/skills/plannen-stories.md` with:

```markdown
## Workflow

1. **Resolve target.** Single event: call `get_event({ id })` or use `list_events` to find the event by title/date. Multi-event / date-range: call `list_events({ from_date, to_date, limit: 50 })` to enumerate.

2. **Load memories.** For each target event call `list_event_memories({ event_id })`. Combine if multi-event. An empty result is fine — generate from event metadata alone (the story will be shorter and more reflective).

3. **Transcribe audio (best-effort).** For each memory where `media_type === 'audio'` AND `transcript` is null, call `transcribe_memory({ memory_id })` once. Behavior:
   - `{ ok: true, transcript, language }` — use the transcript text in the composition prompt as audio context (e.g. `[AUDIO transcript: "<text>"]`).
   - `{ ok: false, error: 'whisper_not_installed' }` — silently skip. Do NOT mention it to the user. Audio falls back to caption-only context.
   - `{ ok: false, error: 'whisper_failed' | 'fetch_failed' }` — log the detail to yourself and skip; treat the memory as caption-only.

4. **Ask for input — always, before composing.** Even if the user's request looked complete, pause and ask for: highlights or moments worth featuring, mood/tone hints (e.g. "warm and reflective", "playful", "matter-of-fact"), people to spotlight, and anything to leave out. Wait for the response. Only the explicit phrasing "just write it" / "no input, go ahead" / "skip the questions" lets you proceed without waiting. Pass anything they mention through to `create_story` as `user_notes` / `mood` / `tone`.

5. **Resolve languages.** Call `get_story_languages()` to get the configured set. If the user named specific languages in the slash-command arguments (e.g. `in nl, fr` or `just english`), parse those and skip the prompt. Otherwise, if the configured set has more than one language, ask:
   > "Your configured languages are <list>. Which would you like for this story? Default: all of them. Reply with a subset like 'en, nl' or 'just en' to limit."
   Wait for the answer. The phrasings "all", "all configured", or "yes" mean all configured languages. A subset MUST come from the configured set; if the user names a code that isn't configured, ask once whether to add it permanently (call `set_story_languages` if yes) or use it just this once (use it as-is for this story without persisting).
   Single-language users (only one configured) skip this prompt automatically.

6. **Sample photos for vision.** Before sampling, filter the combined memories list to `media_type === 'image'` — video and audio rows cannot be used for vision and will cause the curl/Read step to fail. Use the filtered list (`n` = image count) for the sampling calculation. Pick `min(ceil(n/2), 5)` images evenly across the timeline (`floor(i * n / nVision)` for `i in 0..nVision-1`). Images live in local Supabase storage (`http://127.0.0.1:54321/storage/...`), which `WebFetch` cannot reach (sandbox has no localhost access). Instead: `mkdir -p /tmp/story-photos && curl -s "<media_url>" -o /tmp/story-photos/p<i>.jpg` for each sampled URL, then `Read` each local file — `Read` displays JPEGs visually. Run the curls in parallel in one Bash call. Captions on video/audio memories are still useful context — include them when composing. **Audio transcripts (from step 3) become inline text context** alongside the user-set captions.

7. **Compose canonical.** The first selected language (from step 5) is the canonical one. Write a one-line evocative title and a 2–4 paragraph body (~250–600 words) in that language. Tone defaults to "diary"; use the user's mood/tone hints if they gave any.

8. **Persist canonical + translate siblings.** Call `create_story` for the canonical language WITHOUT passing `story_group_id` (the DB auto-generates one):

   ```
   { id, story_group_id, ... } = create_story({
     event_ids, title, body, user_notes?, mood?, tone?, language: <canonical>
   })
   ```

   For each remaining selected language, ask the model to translate the canonical title and body, preserving paragraph structure, tone, proper nouns (names, places). Then call `create_story` again, passing the same `story_group_id`:

   ```
   create_story({
     event_ids, title: <translated>, body: <translated>,
     language: <code>, story_group_id: <from canonical call>,
     user_notes?, mood?, tone?  // pass-through, optional
   })
   ```

   Do NOT pass `cover_url` on translation calls — they'll inherit nothing and the cover is per-row, but the canonical's cover already covers the group display because the StoryReader picks the cover of the currently-viewed sibling.

9. **Persist date-range stories.** For pure date-range stories (`event_ids` empty, `date_from`/`date_to` set), the same multi-language flow applies. Pass `date_from`/`date_to` on every `create_story` call.

10. **Report.** Tell the user the story is saved and visible in the **My Stories** tab. If multiple languages were generated, mention the count: *"Saved in English, Nederlands. View one and tap the language pill to switch."* Offer the `/stories/:id` deep link (use the canonical id) if they ask.
```

Update the heading paragraph at the top of the file (right after the frontmatter) to mention multi-language and audio:

```markdown
# Plannen — stories

When the user asks to "write a story", "make a story", or "tell me about" a past event (or a date range / trip), drive the Plannen MCP tools `get_event` (or `list_events` for ranges) → `list_event_memories` → `transcribe_memory` (for audio, best-effort) → `get_story_languages` → `create_story` (one call per language, sharing `story_group_id`). **Only on explicit request** — never auto-generate.
```

- [ ] **Step 15b: Skim the result**

Read the file end-to-end. Check that:
- The new step 3 (transcribe) is clear about silent fallback.
- Step 5 (resolve languages) handles three branches: arg-passed, configured-multi, single-language.
- Step 8 explicitly does NOT pass story_group_id on the first call.
- The "Editing existing stories" section at the bottom is unchanged.

- [ ] **Step 15c: Commit**

```bash
git add plugin/skills/plannen-stories.md
git commit -m "feat(plugin): stories skill transcribes audio + writes per language

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 16: Self-test pass — type-check, build, vitest, MCP tests

**Files:** none

- [ ] **Step 16a: Frontend type-check + tests**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: zero TS errors. All vitest suites green.

- [ ] **Step 16b: MCP tests + build**

```bash
cd mcp && npm test -- --run && npm run build && cd ..
```

Expected: all MCP vitest suites green, build clean.

- [ ] **Step 16c: Run /plannen-doctor**

In Claude Code, run `/plannen-doctor`. Confirm 0 hard failures.

- [ ] **Step 16d: If anything fails, fix and re-run before continuing**

Do not proceed to the manual verification (Task 17) until 16a–c are clean.

---

## Task 17: Manual end-to-end verification (user runs)

The user runs these steps in person after getting back. The agent does not commit anything in this task — this is a verification list to hand back.

- [ ] **Step 17a: Settings save**

In the web app at `/settings`, set Story languages to `[en, nl, fr]`. Save. Refresh. Confirm selection persists.

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT story_languages FROM user_profiles;"
```

Expected: `{en,nl,fr}`.

- [ ] **Step 17b: Single-language regression**

Reset to `[en]`. Run `/plannen-write-story <existing event with images only>`. Expected:
- The skill does not ask the language-subset question (only one configured).
- One `create_story` call. One row in `stories` for that event. `language='en'`.
- Story renders at `/stories/<id>` with no language pills.

- [ ] **Step 17c: Multi-language without whisper installed**

Set Story languages back to `[en, nl]`. Pick or create an event that has at least one audio memory.

```bash
command -v whisper-cli || echo "whisper-cli NOT installed"
```

If whisper is installed, set `PLANNEN_WHISPER_MODEL=disabled` in `.env` for this test, then restart the MCP (`/mcp` reconnect plannen). This forces the not-installed path even with the binary present.

Run `/plannen-write-story <event with audio>`. Expected:
- The skill calls `transcribe_memory` once and gets `whisper_not_installed`. No user-facing error.
- The skill asks which languages (default all, accept "all"). User says "all".
- Two `create_story` calls (en, nl). Two rows with the same `story_group_id`.
- Story view shows language pills. Clicking NL navigates to the NL sibling.
- The story body does NOT reference audio content (transcript was unavailable).

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT id, language, story_group_id, left(title, 40) FROM stories ORDER BY generated_at DESC LIMIT 3;"
```

Restore `PLANNEN_WHISPER_MODEL=` if you set it.

- [ ] **Step 17d: Multi-language with whisper installed**

If whisper is installed and the model is in place (verify via `/plannen-doctor`):

Run `/plannen-write-story <same event with audio>` again. Expected:
- The skill calls `transcribe_memory` and gets a real transcript. `event_memories.transcript` is populated.
- The story body now references audio content (something the user said in the recording is alluded to).
- Subsequent runs of `/plannen-write-story` for the same event don't re-transcribe (cached: true returned).

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT id, transcript_lang, length(transcript) AS chars FROM event_memories WHERE media_type='audio' ORDER BY created_at DESC LIMIT 3;"
```

Expected: transcript_lang set, chars > 0.

- [ ] **Step 17e: Per-call subset prompt**

Run `/plannen-write-story <event> in nl, fr` (explicit subset in args). Expected:
- The skill skips the language-subset question.
- Two `create_story` calls (nl, fr). The new group has 2 rows; no `en` row this run.

- [ ] **Step 17f: Single-language overwrite scoping**

For a multi-language story group, regenerate just one language: `/plannen-write-story <event> just english`. Expected:
- Only the EN row for that event is overwritten. The NL/FR siblings are untouched.
- `created_at` of the NL row stays unchanged in the DB; `generated_at` of the EN row updates.

- [ ] **Step 17g: Sibling delete behavior**

Delete one sibling story via the web app's delete button. Expected:
- That sibling is gone.
- The remaining siblings still render. Their language-pills row no longer shows the deleted language.

- [ ] **Step 17h: Backup round-trip**

```bash
bash scripts/export-seed.sh
ls -lh supabase/seed.sql supabase/seed-photos.tar.gz
bash scripts/restore-photos.sh
```

Expected: no errors. After restore, all stories still load and language pills still work.

---

## Self-Review

**1. Spec coverage** — every section of `2026-05-10-audio-transcription-multilang-stories-design.md` maps to one or more tasks:

| Spec section | Task(s) |
|---|---|
| Migration `<ts>_audio_transcript_and_story_lang.sql` | 1 |
| TypeScript Memory type | 5 |
| TypeScript Story / siblings | 6 |
| MCP `transcribe_memory` | 9, 10 |
| MCP `get_story_languages` / `set_story_languages` | 11 |
| MCP `create_story` updates | 12 |
| MCP `list_event_memories` updates | 8 |
| MCP `get_story` siblings | 12 |
| `profileService.getStoryLanguages` / set | 3 |
| Settings page Story Languages card | 4 |
| Story view language pills | 7 |
| `whisper-cli` integration | 9 |
| Bootstrap install path | 13 |
| `.env` `PLANNEN_WHISPER_MODEL` | 13 |
| `plannen-doctor` whisper checks | 14 |
| Story-skill workflow | 15 |
| Vitest unit tests | 2, 9 |
| Manual verification | 17 |

No gaps.

**2. Placeholder scan** — searched for "TBD", "TODO", "implement later", "appropriate error handling", "similar to Task" — none present. Every code-edit step shows the actual code.

**3. Type consistency** — `story_group_id`, `language`, `transcript`, `transcript_lang`, `transcribed_at`, `siblings: [{id, language}]`, `whisper_not_installed`, `unsupported_media_type`, `fetch_failed`, `whisper_failed` — all spelled identically across migration, MCP types, frontend types, services, and skills.
