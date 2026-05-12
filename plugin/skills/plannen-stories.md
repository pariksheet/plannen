---
name: plannen-stories
description: Use when the user asks to write a story, make a story, tell the story of a past event or trip, or compose a narrative about an event, date range, or holiday. Drives the Plannen MCP tools get_event/list_events → list_event_memories → create_story. Trigger only on explicit request — never auto-generate stories.
---

# Plannen — stories

When the user asks to "write a story", "make a story", or "tell me about" a past event (or a date range / trip), drive the Plannen MCP tools `get_event` (or `list_events` for ranges) → `list_event_memories` → `transcribe_memory` (for audio, best-effort) → `get_story_languages` → `create_story` (one call per language, sharing `story_group_id`). **Only on explicit request** — never auto-generate.

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

## Editing existing stories

If the user asks to tweak wording or change the cover, call `update_story({ id, title?, body?, cover_url? })` directly — no regeneration needed. The trigger stamps `edited_at`.
