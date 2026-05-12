# Saving Sources (Bookmarks) — Design Spec

## Goal

Let the user bookmark a source (organiser, platform, single-event page) **without** having to create an event first. Today, sources only enter the system as a side-effect of `create_event` with an `enrollment_url` — there is no path to say "save this brunch spot for next time" during discovery. This feature closes that gap with a single new MCP tool and a small set of plugin rules for when the agent should proactively offer to save.

Scope is intentionally narrow: MCP tool + plugin trigger rules. No web UI in this spec.

## Background

The `event_sources` table already supports standalone rows — sources are linked to events through the `event_source_refs` junction, not via a foreign key on `event_sources` itself. The blocker is purely the MCP surface: the only path to create a row today is the internal `upsertSource()` helper, called from `create_event`.

Current source-related MCP tools:

- `search_sources(tags[])` — tag-overlap search across analysed sources
- `update_source(id, name, tags, source_type)` — write analysis fields onto an existing row
- `get_unanalysed_sources()` — list rows where `last_analysed_at IS NULL`

The two existing analysis triggers are:

- Auto: after `create_event` with `enrollment_url` (rules in `plugin/skills/plannen-core.md`)
- Manual: `/plannen-sources` bulk command (rules in `plugin/skills/plannen-sources.md`)

This spec adds a third path — *single-link save mid-conversation* — and the agent-side rules for when to invoke it.

## Architecture

One new MCP tool, `save_source`, that wraps the existing `upsertSource()` helper and writes analysis fields in the same call so no half-tagged rows ever enter the DB. Plugin rules in `plannen-core` govern when the agent calls it — either explicitly (user asks) or proactively (positive-intent or end-of-discovery batch ask).

No schema changes. No new tables. No edge functions.

```
User says "save it as a source"
        │
        ▼
Agent has page content from WebFetch (this turn or prior)?
   ├── yes → derive name/tags/source_type → call save_source(url, name, tags, source_type)
   └── no  → WebFetch first, then call save_source
                                         │
                                         ▼
                          mcp/src/index.ts → upsertSource(url)
                                         │
                                         ▼
                          UPDATE event_sources SET name, tags,
                                  source_type, last_analysed_at = now()
                                  WHERE id = <upserted_id>
                                         │
                                         ▼
                          return { id, domain, action: "inserted"|"updated" }
```

## MCP tool: `save_source`

### Signature

```ts
save_source({
  url: string,           // full source URL, e.g. https://www.pauseandplay.be/
  name: string,          // organiser/platform display name
  tags: string[],        // up to 10, same vocab as update_source
  source_type: "platform" | "organiser" | "one_off"
}) → {
  id: string,            // event_sources.id (existing or newly inserted)
  domain: string,        // extracted hostname (www. stripped)
  action: "inserted" | "updated"
}
```

### Internals

The Supabase JS client doesn't expose multi-statement transactions, so the operation is two sequential PostgREST calls — same pattern as existing `update_source`. If the analysis UPDATE fails after a successful upsert, the row remains in whatever state it was before the call (newly inserted → `last_analysed_at` NULL; pre-existing → previous tags preserved). That's the same recovery surface today's `/plannen-sources` bulk command handles, so no special cleanup is needed.

1. Refactor existing `upsertSource(userId, eventId, url)` to make `eventId` nullable. When `null`, skip the `event_source_refs` insert.
2. In the new `saveSource` handler: call `upsertSource(userId, null, url)` to insert or fetch the row by `(user_id, domain)`. Use the returned `last_analysed_at` to decide `action`: `null` (or row didn't exist before) → `"inserted"`; non-null → `"updated"`.
3. `UPDATE event_sources SET name = $1, tags = $2, source_type = $3, last_analysed_at = now(), updated_at = now() WHERE id = $4 AND user_id = $5`.
4. Return `{ id, domain, action }`.

The `source_url` column is **not** overwritten on update. Rationale: the URL the user originally bookmarked is the canonical entry point; re-saving from a different deep link shouldn't move the pointer.

### Validation

| Field | Rule | Error code on failure |
|---|---|---|
| `url` | Must parse with `new URL()` and have `http(s)` protocol | `invalid_url` |
| `name` | Non-empty string | `name_required` |
| `tags` | Non-empty array; trimmed, lowercased, deduped; capped at 10 (extras silently dropped) | `tags_required` if empty after normalisation |
| `source_type` | One of `platform` \| `organiser` \| `one_off` | `invalid_source_type` |

### Errors

Follows existing MCP convention: handler throws `new Error("<message>")`, the top-level request handler in `mcp/src/index.ts` catches and returns `{ content: [...], isError: true }`. Distinct messages so the agent (and tests) can branch:

- `"invalid url"` — `new URL()` parse failed or non-http(s) protocol
- `"name required"` — empty/whitespace name
- `"tags required"` — no usable tags after normalisation
- `"invalid source_type"` — enum mismatch
- Supabase errors propagate verbatim (DB unreachable, RLS denial, etc.)

Plugin-side mapping of these messages to user-facing wording lives in `plannen-core`.

### Conflict behaviour

On `(user_id, domain)` conflict the tool **updates** the existing row and returns `action: "updated"`. This is intentional — re-saving an already-bookmarked source is a sensible "refresh my tags" gesture. The `event_source_refs` junction is **not** touched.

### Does NOT

- Create rows in `event_source_refs` (no event involved yet).
- Trigger any event-creation side effect.
- Re-analyse on its own — the agent is responsible for deriving `name`/`tags`/`source_type` before calling. The tool is purely a write.

## Plugin trigger rules

New section in `plugin/skills/plannen-core.md`: **"Saving sources (bookmarks)"**.

### Rule 1 — Explicit user request

Phrases that trigger immediate save with no confirmation:

- *"save this as a source"*
- *"bookmark it"* / *"bookmark this"*
- *"save the link"* / *"save that link"*
- *"add it to my sources"*

Flow:

1. If the agent already has page content (WebFetch in this turn or recent context), derive `name`/`tags`/`source_type` from it and call `save_source`.
2. If not, call WebFetch first, then `save_source`.
3. Surface the result in one line: *"Saved Pause & Play as a source."* (or *"Refreshed tags on Pause & Play."* for `action: "updated"`).

### Rule 2 — Positive-intent toward a specific link (proactive, single-link)

Trigger when the user singles **one** link out of a previously presented shortlist with positive sentiment. Concrete signals:

- *"X looks good"* / *"let's go with X"* / *"this one is nice"*
- Sharing actions: *"send to whatsapp"*, *"forward this"*, *"share with Nimisha"*
- Booking-adjacent verbs that don't yet commit to an event: *"let's look at X"*, *"check X out"*

Agent ends its reply with exactly one line:

> *"Want me to save Pause & Play as a source so it shows up in future searches?"*

On affirmative reply, call `save_source`. Don't ask again in the same turn for other links.

### Rule 3 — End-of-discovery batch ask

After any discovery turn that:

- presented **≥2 candidate links**, AND
- the user has **not** already singled one out (Rule 2 didn't fire),

end the reply with exactly one line:

> *"Want me to save any of these as sources for next time? (reply with names, or 'all', or skip)"*

Handling responses:

- Specific names → save those.
- *"all"* / *"yes all"* → save the entire shortlist.
- User ignores the question or changes topic → drop it; never re-ask.

### Suppression rules

- **Already saved**: don't ask if `search_sources` returned a hit for the domain during this turn.
- **No double-asking**: Rule 2 and Rule 3 are mutually exclusive in the same reply. If the user singled one out, Rule 2 wins.
- **One prompt per turn**: at most one save-prompt line in any assistant response.
- **Two-strike suppression**: if the user has declined a save-prompt twice in a row in the same session, suppress for the rest of the session.

### Wording principles

- Always name the specific source(s) — never a bare *"want me to save these?"*.
- One line, at the very end of the reply, after any intent-gate question that's already there.
- Never apologise for asking; never explain the mechanism unless asked.

## Edge cases

1. **Different URL, same domain** (e.g., `lafabbrica.be/en/brunch-brussels.html` vs `lafabbrica.be/contact`) → still one source. The `(user_id, domain)` unique constraint enforces this. `source_url` is preserved from the original insert.

2. **URL with subdomain** (e.g., `app.twizzit.com` vs `twizzit.com`) → separate sources. Domain extraction uses the full host, matching existing `upsertSource()` behaviour.

3. **Source previously created via `create_event` is now being re-saved** → action is `"updated"`, tags refresh. Existing `event_source_refs` rows untouched. No data loss.

4. **WebFetch failed before save_source was called** → agent has no page content, so it can't derive name/tags. The agent must tell the user *"couldn't fetch the page — paste a quick description or skip"* rather than save with placeholder tags. **Never** save with values like `unknown` or empty `name`.

5. **User says "save all" but one URL is unreachable** → save the rest, surface a one-line list of which failed. Don't abort the batch.

## File-level changes

- `mcp/src/index.ts` — register `save_source` tool handler; reuse existing `upsertSource()` then write analysis fields in one SQL update.
- `plugin/skills/plannen-core.md` — add the "Saving sources (bookmarks)" section with Rules 1–3, suppression rules, wording principles.
- `plugin/skills/plannen-sources.md` — add a one-line cross-reference at the top: *"For single-link saves mid-conversation, see save-source rules in plannen-core."*
- **No DB migration.** The schema already supports standalone sources.

## Tests

### Unit (MCP)

- Happy path: `saveSource` with valid args inserts row with `last_analysed_at` set, returns `action: "inserted"`.
- Re-save same domain: returns `action: "updated"`, tags refresh, `source_url` preserved from first insert.
- Throws `"invalid url"` for: non-URL strings, `ftp://`, missing protocol.
- Throws `"name required"` for empty / whitespace-only name.
- Throws `"tags required"` for `[]` or all-whitespace tag array.
- Throws `"invalid source_type"` for enum mismatch.

### Integration

- After `save_source`, the row is findable via `search_sources` with the saved tags (verifies the analysis fields actually wrote through).
- `save_source` does not insert any rows into `event_source_refs`.

### Plugin rules (manual walkthroughs, documented in spec)

Three scripted conversation scenarios, walked through by hand and pasted into the PR description:

1. **Explicit save**: user says "save Pause & Play as a source" mid-discovery → one `save_source` call, one-line confirmation.
2. **Positive-intent single-link**: user says "Pause & Play looks good, send to whatsapp" → agent sends WhatsApp + ends with the Rule 2 prompt. User says "yes" → `save_source` called.
3. **End-of-discovery batch**: user asks "find brunch in Antwerp", agent presents 4 options, user says "save Zelda & Zorro and Bar Chapel" → two `save_source` calls.

## Out of scope (explicitly)

- Web UI for viewing or managing saved sources (deferred to a future spec).
- Bulk delete / un-save tool.
- Source-level notes, user comments, or star ratings.
- Cross-user source sharing (single-user app).
- Re-fetching and re-tagging on a schedule (today's `/plannen-sources` bulk command covers manual refresh).

## Open questions

None at spec-write time. Triggers, tool shape, error codes, and suppression rules are all settled.
