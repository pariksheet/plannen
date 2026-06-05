# Event audio + notes for story generation

**Date:** 2026-05-22
**Type:** Feature — multi-modal memory capture, exposed to the AI story flow.
**Status:** Approved — implementing on `fix/plannen_ui_2226`.

## Problem

Stories generated from an event only use photo captions and (where local Whisper has run) audio transcripts. There's no way to attach a quick text "note" to an event, and no in-app way to record a voice memo at the event — users must already have an audio file on their device to upload one.

For shared events the gap is wider: only the event creator's caption surfaces, so a story about a group outing can't weave in anyone else's observations.

## Decision

Add two narrow capabilities to the event memory surface:

1. **In-browser audio recording.** A Record button next to Upload uses the MediaRecorder API to capture a clip, then funnels it through the existing `uploadMemory()` path (which already detects `media_type='audio'`).
2. **Notes — a separate table.** Multiple users on a shared event can each add multiple notes. Notes are short free text owned by their author. A new MCP tool `list_event_notes(event_ids)` exposes them to the AI story flow alongside `list_event_memories`.

Cloud audio transcription is **out of scope** for this PR. The user's caption on an audio memory carries enough context for the AI; transcription is a separate piece of work.

## End-state

### Schema

New forward-only migration `supabase/migrations/20260522123220_event_notes.sql`:

```sql
CREATE TABLE plannen.event_notes (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  event_id uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_notes_event_id ON plannen.event_notes(event_id);
CREATE INDEX idx_event_notes_user_id ON plannen.event_notes(user_id);

ALTER TABLE plannen.event_notes ENABLE ROW LEVEL SECURITY;
```

RLS policies mirror `event_memories`:

- **SELECT:** anyone who can see the parent event (delegates to the canonical event-visibility expression: owner, personal share, group share, or shared_with_friends='all' + accepted relationship).
- **INSERT:** `user_id = auth.uid()`.
- **UPDATE/DELETE:** `user_id = auth.uid()`.

Audio is already in the `event_memories.media_type` CHECK constraint — no migration change for audio.

### Service layer (`src/services/noteService.ts`)

```ts
listEventNotes(eventId): Promise<{ data: EventNote[]; error: Error | null }>
createNote(eventId, body): Promise<{ data: EventNote | null; error: Error | null }>
updateNote(id, body): Promise<{ data: EventNote | null; error: Error | null }>
deleteNote(id): Promise<{ error: Error | null }>
```

`EventNote` shape includes the author's `full_name` and `email` (joined) so the UI can render attribution without a second round-trip.

### dbClient (`src/lib/dbClient`)

- `types.ts`: new `NoteRow` plus a `notes` block on `DbClient`.
- `tier1.ts`: implements via supabase-js with an `author:users(full_name,email)` join.
- `tier0.ts`: REST under `/api/event-notes/...`.

### Tier-0 backend

New routes in `backend/src/routes/`:
- `GET /api/event-notes?event_id=<id>` — list
- `POST /api/event-notes` — create `{ event_id, body }`
- `PATCH /api/event-notes/:id` — update `{ body }`
- `DELETE /api/event-notes/:id` — delete

Single-user mode skips RLS; routes still scope by `current_user_id`.

### MCP tool (`mcp/src/index.ts`)

New `list_event_notes(event_ids: string[])` mirrors `list_event_memories`:
- Verifies the caller owns each event.
- Returns rows ordered by `event_id, created_at ASC` with `author_full_name`, `author_email`, `body`, `created_at`.

### plannen-stories skill (`plugin/skills/plannen-stories.md`)

Add a step between `list_event_memories` and `create_story`: also call `list_event_notes` for the same event ids, and include notes (attributed to their authors with timestamps) in the prompt context that produces the story body. No schema change to the `create_story` MCP tool — notes are input context, not stored on the story row.

### Audio recorder (`src/components/AudioRecorder.tsx`)

- One button. Tap to start, tap again to stop. While recording: pulsing red dot + MM:SS timer.
- Permission gate: `navigator.mediaDevices?.getUserMedia` feature-detect; if unavailable, the button is hidden entirely.
- Format: `MediaRecorder` with `mimeType: 'audio/webm;codecs=opus'` if supported, else `'audio/mp4'` (Safari fallback), else first supported type.
- On stop: assemble Blob → wrap in synthetic `File` named `recording-<timestamp>.<ext>` → hand to the parent's upload handler. No separate "upload after record" step; the recorder owns the full lifecycle through to handing over the File.
- Mobile-first: 44px tap target; permission denial shows inline error.

### Audio playback (`src/components/MemoryImage.tsx`)

The component already routes by `media_type`. Add an `audio` branch:
- Grid: speaker icon + caption (if any).
- Lightbox: full-width `<audio controls>` plus caption.

Video already has its own branch; this is the same pattern.

### Notes UI (`src/components/EventNotes.tsx`)

Rendered immediately below the memories grid inside the existing memories section.

- Compose: single-line growing `<textarea>` + "Add note" button. Enter submits; Shift+Enter newline.
- List: each note card shows author label (own → "You", others → full_name or email), relative timestamp, body. Own notes get inline Edit/Delete actions.
- Edit: in-place textarea + Save/Cancel.
- Delete: confirm modal (matches existing pattern).
- Empty state: small prompt ("Add a note to remember this — observations, quotes, plans").

### Wiring (`src/components/EventMemory.tsx`)

`<EventNotes eventId={eventId} />` is rendered after the memories grid. The audio recorder lives next to the existing Upload button in the action row.

### Tier handling

- Audio upload + playback: all tiers (no new bucket; uses existing event-photos with a different content-type).
- Recording: any browser with MediaRecorder.
- Notes: all tiers. Tier-0 single-user can still write notes on their own events.

## Out of scope (deferred)

- Cloud audio transcription (Whisper API / Claude). User captions carry the gap.
- Note threading / replies / @-mentions.
- Markdown rendering in notes (plain text only this PR).
- Voice-to-text dictation in the recorder.
- Renaming `MemoryImage.tsx` to reflect its multi-type role.

## Rollout

1. Migration applies via `npx plannen migrate` (Tier 2: `supabase db push --project-ref`).
2. Existing event memories untouched. Notes table starts empty.
3. The plannen-stories skill picks up the new step at next conversation; no MCP server restart needed in dev (TypeScript MCP rebuilds on save).
