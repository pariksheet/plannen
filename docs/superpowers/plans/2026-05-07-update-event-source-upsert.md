# update_event Source Upsert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `update_event` (MCP) upsert a source record for the event's `enrollment_url`, identical to what `create_event` already does — so existing events with URLs that pre-date the source feature get seeded when next updated.

**Architecture:** Extract the inline source-upsert block from `createEvent` into a shared `upsertSource` helper, then call it from `updateEvent` after the DB update. `updateEvent` already selects the full row back (including `enrollment_url`), so no schema change is needed.

**Tech Stack:** TypeScript, Supabase JS client, MCP SDK

---

### Task 1: Extract source upsert into a shared helper

**Files:**
- Modify: `mcp/src/index.ts:253-273` (inline block in `createEvent`) and `mcp/src/index.ts:278-301` (`updateEvent`)

- [ ] **Step 1: Add the helper function** just before `createEvent` (around line 190). Insert after the `generateSessionDates` function:

```typescript
async function upsertSource(
  userId: string,
  eventId: string,
  enrollmentUrl: string
): Promise<{ id: string; last_analysed_at: string | null } | null> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return null
  const { data: src, error: srcErr } = await db
    .from('event_sources')
    .upsert(
      { user_id: userId, domain, source_url: enrollmentUrl },
      { onConflict: 'user_id,domain' }
    )
    .select('id, last_analysed_at')
    .single()
  if (srcErr || !src) return null
  await db.from('event_source_refs').upsert(
    { event_id: eventId, source_id: src.id, user_id: userId, ref_type: 'enrollment_url' },
    { onConflict: 'event_id,source_id' }
  )
  return { id: src.id, last_analysed_at: src.last_analysed_at }
}
```

- [ ] **Step 2: Replace the inline block in `createEvent`** (lines 253–273) with a call to the helper:

Replace:
```typescript
  let source: { id: string; last_analysed_at: string | null } | null = null
  if (data && args.enrollment_url) {
    const domain = extractDomain(args.enrollment_url)
    if (domain) {
      const { data: src, error: srcErr } = await db
        .from('event_sources')
        .upsert(
          { user_id: id, domain, source_url: args.enrollment_url },
          { onConflict: 'user_id,domain' }
        )
        .select('id, last_analysed_at')
        .single()
      if (!srcErr && src) {
        await db.from('event_source_refs').upsert(
          { event_id: data.id, source_id: src.id, user_id: id, ref_type: 'enrollment_url' },
          { onConflict: 'event_id,source_id' }
        )
        source = { id: src.id, last_analysed_at: src.last_analysed_at }
      }
    }
  }

  return { ...data, source }
```

With:
```typescript
  const source = data && args.enrollment_url
    ? await upsertSource(id, data.id, args.enrollment_url)
    : null

  return { ...data, source }
```

- [ ] **Step 3: Add source upsert to `updateEvent`** — after the update succeeds, call the helper if the returned event has an `enrollment_url`:

Replace the current `updateEvent` return (last line):
```typescript
  if (error) throw new Error(error.message)
  return data
```

With:
```typescript
  if (error) throw new Error(error.message)
  const source = data?.enrollment_url
    ? await upsertSource(id, args.id, data.enrollment_url)
    : null
  return { ...data, source }
```

- [ ] **Step 4: Build the MCP to verify no TypeScript errors**

```bash
cd mcp && npm run build
```

Expected: no errors, outputs to `dist/`.

- [ ] **Step 5: Restart the MCP server** so Claude Code picks up the new build.

The MCP server runs as a child process — kill and restart it via the app or by restarting Claude Code.

- [ ] **Step 6: Verify manually** — call `update_event` on one of the events with an `enrollment_url` (e.g. Kayaking Beginners `920a428c`), then call `get_unanalysed_sources`. It should now return that source.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat: upsert event source in update_event, same as create_event"
```

---

### Self-review

**Spec coverage:**
- Gap: `update_event` didn't create sources → Task 1 Step 3 fixes it ✓
- DRY: inline code extracted to `upsertSource` helper, called from both create and update ✓

**Placeholder scan:** None — all steps have concrete code.

**Type consistency:** `upsertSource` returns `{ id: string; last_analysed_at: string | null } | null` — same shape used in `createEvent`'s existing `source` return type ✓
