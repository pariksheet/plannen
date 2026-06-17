# Sharing Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the fragmented event-sharing model (`shared_with_friends` enum + two junction tables) with one unified `event_shares` table carrying a permission **level** (`awareness`/`assigned`), a per-recipient **adoption** inbox, and a global **default-share** rule — exposed through both MCP servers and the web services.

**Architecture:** A forward-only migration creates `event_shares` + `event_share_adoption`, backfills from the old junctions, and repoints the SECURITY DEFINER RLS helpers + a new `user_can_see_event(id)` (incl. a trip-container branch) so every existing reader uses the new table. Old junctions stay read-dormant for one release. New writers (MCP tools + web `shareService`) write only `event_shares`. Assignee completion goes through a `complete_event(id)` RPC.

**Tech Stack:** Postgres/PLpgSQL (Supabase), Deno (edge MCP), Node/TS (local MCP + web services), Vitest.

## Global Constraints

- Repo is PUBLIC — no personal data in any file. Generic personas only.
- DB migrations forward-only; never `db reset`; back up first (done 2026-06-17).
- MCP parity: every new tool in BOTH `mcp/src/index.ts` and a `ToolModule` under `supabase/functions/mcp/tools/`, registered in the edge `TOOLS` array, passing `node scripts/check-mcp-parity.mjs`.
- Edge functions never read keys from request bodies; all access `auth.uid()` / `ctx.userId` scoped.
- Migration timestamp: `20260617150000_unified_event_shares.sql` (after the latest `20260617140000`).
- Do NOT push or apply the migration to prod — that is a separate gated `npx plannen migrate` step the maintainer triggers.

---

### Task 1: Migration — tables, columns, backfill, RLS, RPC

**Files:**
- Create: `supabase/migrations/20260617150000_unified_event_shares.sql`

**Interfaces produced:**
- Tables `plannen.event_shares(id, event_id, target_type, target_id, level, created_by, created_at)`, `plannen.event_share_adoption(event_id, user_id, adopted_at)`.
- `user_settings` columns `default_share_enabled bool`, `default_share_target_type text`, `default_share_target_id uuid`, `default_share_level text`.
- Functions `plannen.user_can_see_event(uuid) → bool`, `plannen.complete_event(uuid) → events row`. Helpers `user_in_event_group`, `user_in_event_shared_with_users` repointed to `event_shares`.

- [ ] **Step 1:** Write the migration SQL (full content below).
- [ ] **Step 2:** Lint locally: `node -e "const s=require('fs').readFileSync('supabase/migrations/20260617150000_unified_event_shares.sql','utf8'); console.log(s.length>0?'ok':'empty')"` and eyeball the diff. (No prod apply.)
- [ ] **Step 3:** Commit `feat(sharing): unified event_shares schema + RLS + complete_event RPC`.

```sql
-- Unified event sharing: one table, one level, plus a per-recipient adoption
-- inbox and a global default-share rule. Forward-only. Old junctions
-- (event_shared_with_groups/users) + events.shared_with_friends stay present
-- but read-dormant after this migration repoints the RLS helpers; a later
-- migration drops them.

-- 1. Tables -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plannen.event_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user','group','all')),
  target_id   uuid,
  level       text NOT NULL DEFAULT 'awareness' CHECK (level IN ('awareness','assigned')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_shares_target_id_shape CHECK (
    (target_type = 'all' AND target_id IS NULL)
    OR (target_type IN ('user','group') AND target_id IS NOT NULL)
  ),
  UNIQUE (event_id, target_type, target_id)
);
-- NULLs are distinct in UNIQUE, so guard the single 'all' row separately.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_shares_all
  ON plannen.event_shares (event_id) WHERE target_type = 'all';
CREATE INDEX IF NOT EXISTS idx_event_shares_event   ON plannen.event_shares (event_id);
CREATE INDEX IF NOT EXISTS idx_event_shares_target  ON plannen.event_shares (target_type, target_id);

ALTER TABLE plannen.event_shares ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE plannen.event_shares TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS plannen.event_share_adoption (
  event_id   uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
ALTER TABLE plannen.event_share_adoption ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE plannen.event_share_adoption TO anon, authenticated, service_role;

-- 2. Default-share rule on user_settings ------------------------------------
ALTER TABLE plannen.user_settings
  ADD COLUMN IF NOT EXISTS default_share_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_share_target_type text
    CHECK (default_share_target_type IN ('user','group','all')),
  ADD COLUMN IF NOT EXISTS default_share_target_id uuid,
  ADD COLUMN IF NOT EXISTS default_share_level text NOT NULL DEFAULT 'awareness'
    CHECK (default_share_level = 'awareness');

-- 3. Backfill from the old sources, all at level 'awareness' -----------------
INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT esg.event_id, 'group', esg.group_id, 'awareness', e.created_by, esg.created_at
  FROM plannen.event_shared_with_groups esg
  JOIN plannen.events e ON e.id = esg.event_id
ON CONFLICT DO NOTHING;

INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT esu.event_id, 'user', esu.user_id, 'awareness', e.created_by, esu.created_at
  FROM plannen.event_shared_with_users esu
  JOIN plannen.events e ON e.id = esu.event_id
ON CONFLICT DO NOTHING;

INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT e.id, 'all', NULL, 'awareness', e.created_by, now()
  FROM plannen.events e
 WHERE e.shared_with_friends = 'all'
ON CONFLICT DO NOTHING;

-- 4. Unified visibility helper (SECURITY DEFINER → no policy recursion) ------
CREATE OR REPLACE FUNCTION plannen.user_can_see_event(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  WITH me AS (SELECT auth.uid() AS uid)
  SELECT EXISTS (
    -- direct shares on the event, or shares on the event's container (trip branch)
    SELECT 1
      FROM plannen.event_shares s
      JOIN plannen.events e ON e.id = p_event_id
     WHERE (s.event_id = p_event_id OR s.event_id = e.group_id)
       AND (
            (s.target_type = 'user'  AND s.target_id = (SELECT uid FROM me))
         OR (s.target_type = 'group' AND EXISTS (
               SELECT 1 FROM plannen.friend_group_members fgm
                WHERE fgm.group_id = s.target_id AND fgm.user_id = (SELECT uid FROM me)))
         OR (s.target_type = 'all'   AND EXISTS (
               SELECT 1 FROM plannen.relationships r
                WHERE r.status = 'accepted'
                  AND ((r.user_id = (SELECT uid FROM me) AND r.related_user_id = s.created_by)
                    OR (r.user_id = s.created_by AND r.related_user_id = (SELECT uid FROM me)))))
       )
  )
$$;
GRANT ALL ON FUNCTION plannen.user_can_see_event(uuid) TO anon, authenticated, service_role;

-- Repoint legacy helpers at event_shares so existing rsvps/memories policies
-- that call them keep working off the new source (old junctions now dormant).
CREATE OR REPLACE FUNCTION plannen.user_in_event_group(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.event_shares s
      JOIN plannen.friend_group_members fgm ON fgm.group_id = s.target_id
     WHERE s.event_id = p_event_id AND s.target_type = 'group'
       AND fgm.user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION plannen.user_in_event_shared_with_users(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.event_shares s
     WHERE s.event_id = p_event_id AND s.target_type = 'user'
       AND s.target_id = auth.uid()
  )
$$;

-- 5. Collapse the events SELECT share-policies into one ----------------------
DROP POLICY IF EXISTS "Users can view events shared with their groups" ON plannen.events;
DROP POLICY IF EXISTS "Users can view events shared with them directly" ON plannen.events;
DROP POLICY IF EXISTS "Users can view events shared with all friends" ON plannen.events;
CREATE POLICY "Users can view shared events"
  ON plannen.events FOR SELECT
  USING (created_by <> auth.uid() AND plannen.user_can_see_event(id));

-- 6. event_shares policies: readable if you can see the parent event; only the
--    event creator may mutate shares.
DROP POLICY IF EXISTS "View shares for visible events" ON plannen.event_shares;
CREATE POLICY "View shares for visible events" ON plannen.event_shares
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id
               AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id)))
  );
DROP POLICY IF EXISTS "Event creator manages shares" ON plannen.event_shares;
CREATE POLICY "Event creator manages shares" ON plannen.event_shares
  FOR ALL USING (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id AND e.created_by = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id AND e.created_by = auth.uid())
  );

-- 7. adoption policies: a user manages only their own rows, for events they see.
DROP POLICY IF EXISTS "Users manage own adoption" ON plannen.event_share_adoption;
CREATE POLICY "Users manage own adoption" ON plannen.event_share_adoption
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid()
    AND (EXISTS (SELECT 1 FROM plannen.events e
                  WHERE e.id = event_share_adoption.event_id
                    AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id)))));

-- 8. complete_event RPC: creator OR an 'assigned'-level recipient may flip
--    completion. No broad assignee UPDATE grant on events.
CREATE OR REPLACE FUNCTION plannen.complete_event(p_event_id uuid, p_done boolean DEFAULT true)
RETURNS plannen.events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = plannen, public
AS $$
DECLARE r plannen.events;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM plannen.events e WHERE e.id = p_event_id AND e.created_by = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1 FROM plannen.event_shares s
     WHERE s.event_id = p_event_id AND s.level = 'assigned'
       AND ((s.target_type = 'user'  AND s.target_id = auth.uid())
         OR (s.target_type = 'group' AND EXISTS (
               SELECT 1 FROM plannen.friend_group_members fgm
                WHERE fgm.group_id = s.target_id AND fgm.user_id = auth.uid())))
  ) THEN
    RAISE EXCEPTION 'not allowed to complete this event';
  END IF;
  UPDATE plannen.events
     SET completed_at = CASE WHEN p_done THEN now() ELSE NULL END
   WHERE id = p_event_id
  RETURNING * INTO r;
  RETURN r;
END;
$$;
GRANT EXECUTE ON FUNCTION plannen.complete_event(uuid, boolean) TO anon, authenticated, service_role;
```

---

### Task 2: Edge MCP — `shares.ts` ToolModule + create/update default rule

**Files:**
- Create: `supabase/functions/mcp/tools/shares.ts`
- Modify: `supabase/functions/mcp/index.ts` (import + add `sharesModule` to `TOOLS`)
- Modify: `supabase/functions/mcp/tools/events.ts` (apply default rule in `create_event`; `share` passthrough)

**Interfaces produced (tool names — must match local exactly):** `share_event`, `unshare_event`, `assign_todo`, `adopt_shared_event`, `unadopt_shared_event`, `complete_event`.

- [ ] **Step 1:** Write `shares.ts` following the `checklists.ts` ToolModule shape. `share_event(event_id, targets:[{type,id?}], level?)` — owner-only, upsert `event_shares` rows. `unshare_event(event_id, target_type, target_id?)` — delete one row. `assign_todo(todo_id, targets)` — owner-only, insert `event_shares` rows at `level='assigned'` (validate event_kind='todo'). `adopt_shared_event(event_id)` / `unadopt_shared_event` — insert/delete own adoption row (must be able to see the event). `complete_event(event_id, done?)` — `SELECT * FROM plannen.complete_event($1,$2)`.
- [ ] **Step 2:** Register in `index.ts`.
- [ ] **Step 3:** In `events.ts` `create_event`, after insert: if caller passed `share` use it; if `share===null`/`[]` skip; if omitted, read `user_settings` default and insert one `event_shares` row when `default_share_enabled`. Mirror the container-inheritance (container's shares copy to child via one `event_shares` row pointing at child) — but prefer the trip RLS branch, so child needs NO own share rows; just ensure `create_event` no longer needs to copy.
- [ ] **Step 4:** `node scripts/check-mcp-parity.mjs` → expect failure until Task 3 mirrors (names appear only on cloud side now). Defer the green check to Task 3.
- [ ] **Step 5:** Commit `feat(sharing): edge MCP share/assign/adopt/complete tools + default rule`.

---

### Task 3: Local MCP — mirror tools + default rule (parity green)

**Files:**
- Modify: `mcp/src/index.ts` (definitions in the `tools` array, handler functions, `switch` dispatch cases, `create_event` default rule)

- [ ] **Step 1:** Add identical `name:` definitions + handler functions + `case` arms for all six tools, using `withUserContext` + `pg.Pool` exactly like `shareChecklist`. Reuse the same SQL as the edge module.
- [ ] **Step 2:** Apply the default-share rule in the local `create_event` (same contract).
- [ ] **Step 3:** `node scripts/check-mcp-parity.mjs` → expect `✓ MCP tool parity holds`.
- [ ] **Step 4:** Commit `feat(sharing): local MCP share tools mirror + parity`.

---

### Task 4: Web `shareService` + viewService inbox/trip branch

**Files:**
- Create: `src/services/shareService.ts`
- Modify: `src/services/viewService.ts`, `src/services/eventService.ts`, `src/services/containerService.ts`

**Interfaces produced:** `shareService.setShares`, `addShare`, `removeShare`, `adoptShare`, `unadoptShare`, `getSharesFor`, `getSharedWithMeInbox`.

- [ ] **Step 1:** `shareService.ts` — supabase-js reads/writes against `event_shares` + `event_share_adoption` (Tier-0 guard returns empty like the existing services).
- [ ] **Step 2:** `viewService.getGroupsEvents` — read `event_shares` (target_type='group', my groups) AND container shares whose children should surface; merge/dedupe via `fetchEventsByIds`. Replace `event_shared_with_groups` query.
- [ ] **Step 3:** `viewService.getEventsSharedWithMeDirectly` — read `event_shares` (target_type in user/all) instead of `event_shared_with_users` + `shared_with_friends='all'`. Add `getSharedWithMeInbox()` = awareness shares to me with no adoption row.
- [ ] **Step 4:** `eventService.getEventSharedWithUserIds` → read `event_shares`. `createEvent`/`updateEvent` → write via `shareService` + apply default rule when no share specified. `containerService.syncTripSharing` → `shareTrip` writes one container `event_shares` row, drop per-child copy.
- [ ] **Step 5:** `npm run build` / typecheck green; commit `feat(sharing): web shareService + view rewrite to event_shares`.

---

### Task 5: Tests + parity + final verification

**Files:**
- Create/modify: edge tool test `supabase/functions/mcp/tools/shares.test.ts` (mirror `checklists.test.ts` shape), web `src/services/shareService.test.ts` if a harness exists.

- [ ] **Step 1:** Edge test: share_event inserts rows; assign_todo sets level='assigned'; adopt/unadopt; complete_event allowed for assignee, rejected for awareness-only.
- [ ] **Step 2:** `npm run check:parity` and the repo test command (`npm run test:cli` / vitest) green.
- [ ] **Step 3:** Commit `test(sharing): edge + service coverage for unified shares`.

## Self-Review notes

- Spec coverage: tables+columns (T1), RLS+RPC (T1), MCP tools both servers (T2/T3), default rule (T2/T3/T4), views+inbox+trip branch (T4), backfill (T1), testing (T5). ✓
- Trip branch handled in `user_can_see_event` via `s.event_id = e.group_id`, so children need no own share rows — matches "share once → children follow."
- Old junctions/`shared_with_friends` left intact; helpers repointed so existing event_rsvps/event_memories policies (which call the helpers) transparently use `event_shares`. The inline `shared_with_friends='all'` branch in those two policies becomes redundant but harmless (still true only if the column is set); new 'all' shares are also written to `event_shares`, covered by `user_can_see_event` where those policies call it — NOTE: event_rsvps/event_memories policies do NOT call user_can_see_event, they inline. They keep working for legacy 'all' rows; new flows surface events via the events policy. Acceptable for the dormant release; a follow-up can unify them.
- Not applied to prod; maintainer runs `npx plannen migrate` after review.
