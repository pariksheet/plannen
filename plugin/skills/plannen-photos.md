---
name: plannen-photos
description: Use when the user asks to find photos, organise photos, scan photos, or add photos for a Plannen event. Drives the Google Photos picker via create_photo_picker_session + poll_photo_picker_session. Trigger only on explicit request — never run proactively.
---

# Plannen — photo organisation

When the user asks to "find photos", "organise photos", "scan photos", or "add photos" for an event, drive the Google Photos picker via the Plannen MCP tools `create_photo_picker_session` + `poll_photo_picker_session`. **Only on explicit request** — never run proactively.

Background: Google deprecated Library API access to user-library photos in March 2025. The picker is the only way to surface user photos, and picker mediaItem ids only resolve while the session is fresh. So at attach-time, `poll_photo_picker_session` downloads bytes into the local `event-photos` storage bucket and stores the public URL on the `event_memories` row — that's why photos display permanently after attaching.

## Workflow

1. **Resolve target event.** If the user names an event, call `list_events` to find it. If they describe a date/activity instead ("photos from yesterday at the museum"), match against recent events; if none exists, offer to create one first.

2. **Create picker session.** Call `create_photo_picker_session`. Surface the returned `picker_uri` to the user as a clickable link with a clear instruction: "Open this in your browser, pick the photos for [event], then tell me when you're done."

3. **Poll on user signal.** When the user says they're done (or "ready", "picked", etc.), call `poll_photo_picker_session({ session_id, event_id })`.
   - `status: "pending"` → user hasn't finished. Tell them and wait.
   - `status: "complete"` → report `attached.length` and any `skipped` items with reasons. Already-attached items show `already: true` (idempotent re-runs are safe).

4. **Report.** One line per event: title, count attached, count skipped. List skipped items with reasons.

## Notes

- Re-runs are idempotent via the unique index on `(event_id, external_id)`. Manually deleted memories **will** be re-attached if the user picks the same photos again.
- There's no automatic date-window scan and no vision triage — the user picks visually in Google's UI, which is faster and avoids false positives.
- Videos and non-PHOTO types are skipped with a reason.
