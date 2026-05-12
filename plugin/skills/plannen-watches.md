---
name: plannen-watches
description: Use when processing the Plannen watch queue — either at session start (auto-fetched in plannen-core) or when the user explicitly says "check my watched events" / "process watches". Handles fetching enrollment URLs, comparing with saved state, detecting meaningful changes, updating events when dates or registration change, and scheduling the next check. Future cloud routines will also call this skill.
---

# Plannen — watch monitoring

The watch queue is checked automatically at session start (see `plannen-core`). This skill describes the per-event processing.

## Manual trigger

The user can say "check my watched events" at any time to force an immediate run regardless of `next_check`. Call `get_watch_queue` and process each returned event below. If the queue is empty, say so.

## Processing a watched event

1. **Fetch** the `enrollment_url` using WebFetch.
   - Any network error or non-200 response counts as a failure — increment `fail_count`. At 3 consecutive failures set `status: "failed"` in `update_watch_task` and tell the user: *"[Event title] watch failed — the page was unreachable. Check manually."*
   - On success, reset `fail_count` to 0.

2. **Web search** for the event using what you know: search for the event title plus the next expected year (e.g. `"Brussels Motor Show 2027 dates"`). This surfaces early announcements on news sites, forums, or secondary sources that may appear before the official site is updated. Merge any concrete findings (confirmed dates, prices, registration links) into the extracted data, noting the source in `notes`.

3. **Extract** structured data combining both sources into `last_result`:

   ```json
   { "dates": "e.g. July 14–25 2027", "price": "e.g. €450/week", "enrollment_open": true, "deadline": "e.g. 2027-03-01", "notes": "any other relevant detail, including source if from web search" }
   ```

   Omit keys you couldn't find. `enrollment_open` should be `true` if a registration/signup link is clearly present and active.

4. **Compute `last_page_hash`**: use the first 1000 characters of the official page's main text content as a fingerprint string. This is what you compare across checks.

5. **Compare** to `last_result` from the task record. A meaningful change is any of: dates changed, price changed, `enrollment_open` flipped to true, deadline added or changed. Ignore changes only in `notes`.

6. **If changed:**
   - Call `update_event` with updated fields: `start_date` and `end_date` if new dates found, `description` if price/deadline info should be recorded. When updating `start_date` for a recurring event, also prepend "Previous edition: [old date]" to the description so the prior occurrence is remembered.
   - Call `update_watch_task` with `has_unread_update: true`, the new `last_result`, new `last_page_hash`, updated `next_check`, and an `update_summary` like *"Registration now open · €450/week"*. If new confirmed dates were found, also pass `last_occurrence_date` set to the new confirmed start date (ISO, e.g. `"2027-01-09"`).
   - Tell the user: *"[Event title] — [what changed]. I've updated the event. You may want to change the status to `planned` or `going`."*

7. **If unchanged:**
   - Call `update_watch_task` with `has_unread_update: false`, the same `last_result`, new `last_page_hash`, and updated `next_check`.
   - Produce no output.

## next_check calculation

For recurring events (`recurrence_months` is set), use the **predicted next date** = `last_occurrence_date` + `recurrence_months` months as the anchor for scheduling — not necessarily the event's `start_date` (which may still be a rough estimate).

Compute from the anchor date:

- More than 6 months away → add 7 days
- 1–6 months away → add 2 days
- Less than 1 month away → add 1 day
- After a failure → add 1 hour (first failure), 1 day (second)

## Recurring events (annual, biannual, etc.)

Some watched events repeat on a known schedule. These have `recurrence_months` set (e.g. `12` for annual) and `last_occurrence_date` recording the previous confirmed occurrence.

When the current event's `start_date` is in the past and `recurrence_months` is set, the event's `start_date` represents the **predicted** next date (= `last_occurrence_date` + `recurrence_months`). Watch the same `enrollment_url` — the organisation updates their site for the next edition.

When confirmed dates for the next edition appear on the page, treat this as a meaningful change: update the event's `start_date`/`end_date` to the confirmed dates, prepend "Previous edition: [old date]" to the description, and advance `last_occurrence_date` to the newly confirmed start date.
