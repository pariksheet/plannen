# Plannen OSS Blockers — Design

**Date:** 2026-05-09
**Status:** Design approved; pending spec review and implementation plan
**Branch:** feat/tier-1-opensource (rebased onto feat/tier-1-stories)
**Related:** `2026-05-09-plannen-plugin-architecture-design.md`, `2026-05-09-byok-design.md`

## Context

This spec covers the work required to make Plannen ready for public OSS release that isn't covered by the plugin architecture or BYOK specs. It is the residual list of housekeeping items, legal/license decisions, PII cleanup, and small spec amendments that emerged from a real audit of `feat/tier-1-stories` (the canonical development branch, 181 commits ahead of `main`).

The audit revealed that several "blockers" assumed earlier were wrong on premise:

- **MCP source is not missing.** `mcp/src/`, `mcp/package.json`, `mcp/tsconfig.json`, `mcp/vitest.config.ts`, `mcp/.env.example` all exist on `feat/tier-1-stories`. `mcp/dist/` is gitignored, not committed.
- **`.mcp.json` is not committed.** Only `.mcp.json.example` is. Local `.mcp.json` is a per-machine artefact.
- **`README.md`, `CLAUDE.md`, `.env.example`, `.mcp.json.example` all exist** with reasonable initial content.
- **No real secrets ever entered git history** — verified `sk-ant-`, `GOCSPX-`, `GEMINI=AIza...` all absent from history.
- **Logs (`*.log`) are already gitignored.**

What remains is genuinely small. This spec captures it.

## Goals & non-goals

### Goals

- Plannen has a license file that supports the Tier 4 monetization plan (AGPL-3.0).
- No personal-content files are committed in the working tree of the canonical branch.
- macOS-specific noise (`.DS_Store`) is removed from the working tree and prevented from re-entering.
- Backup artefacts (`supabase/seed-photos.tar.gz`) are protected from accidental commits the same way `seed.sql` is.
- The two earlier specs (plugin architecture, BYOK) have their factual errors corrected.
- The root README accurately reflects the V1 architecture (plugin + BYOK) before public release.

### Non-goals

- Rewriting git history. The motivation letter remains in past commits.
- Adopting a CONTRIBUTING.md or CODE_OF_CONDUCT.md in V1. Can be added later when contributors appear.
- Renaming or restructuring directories beyond what plugin/BYOK already require.

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| License | AGPL-3.0 | MIT (no copyleft, no protection for hosted-Plannen monetization); Apache-2.0 (same trade-off + patent grant); GPL-3.0 (no network-use clause; weaker than AGPL for SaaS context). |
| History rewrite | Leave intact | `git filter-repo` to strip motivation letter (would require force-push to `origin/feat/tier-1-stories`; unnecessary since the file is not a secret). |
| README scope | Update existing 338-line README to reflect plugin+BYOK V1 architecture | Rewrite from scratch; defer all polish to post-V1. |
| Spec amendments | Fix factually wrong sections in plugin + BYOK specs in this PR | Leave specs unchanged; defer corrections; supersede with new specs. |

## Action items

### A. License — add AGPL-3.0

1. Create `LICENSE` at repo root with the AGPL-3.0 text from https://www.gnu.org/licenses/agpl-3.0.txt.
2. Add a license badge / header line to root `README.md`: "Licensed under [AGPL-3.0](LICENSE)."
3. Add `"license": "AGPL-3.0-only"` to root `package.json` and `mcp/package.json`.
4. Add a `LICENSE` reference and SPDX identifier to `plugin/.claude-plugin/plugin.json` when the plugin is created (per plugin spec section 2 — `"license": "AGPL-3.0-only"`).

### B. PII / personal-content cleanup

1. **Delete `umicore_data_analytics_tech_lead_motivation_letter.md` from the working tree.** `git rm`. Commit with a clear message ("chore: remove unrelated personal file from working tree"). It remains in git history; this is the deliberate trade-off (no force-push, no clone breakage).
2. **Genericize my personal email in the plugin spec.** `pbarapatre@gmail.com` appears once in `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` as an example. Replace with `you@example.com`.
3. **Audit `.mcp.json` (local-only file) before publishing.** Currently has `PLANNEN_USER_EMAIL=pbarapatre@gmail.com`. Since it's not committed, no history concern — but the maintainer should regenerate it from `.mcp.json.example` after the plugin is installed (since the plugin replaces direct `.mcp.json` use anyway).

### C. macOS noise

1. **Remove `.DS_Store` from git tracking.** `git rm --cached .DS_Store`.
2. **Add `.DS_Store` to `.gitignore`.** Single line near top: `.DS_Store`.
3. Optional: `**/.DS_Store` if any sub-directory `.DS_Store` files are also tracked (verify with `git ls-files | grep DS_Store`).

### D. Backup artefacts

1. **Add `supabase/seed-photos.tar.gz` to `.gitignore`.** Mirrors the existing `supabase/seed.sql` rule. Both are personal backups, both must never be accidentally committed.

### E. Plugin spec amendments

The plugin architecture spec (`2026-05-09-plannen-plugin-architecture-design.md`) has factual errors that need correcting. None affect the design; they affect the assumed starting state.

1. **Section 1 (Repository layout):** Remove the `mcp/src/` "NEW — currently missing" annotation. The directory exists with `index.ts`, `recurrence.{ts,test.ts}`, `profileFacts.{ts,test.ts}`. Remove the `mcp/package.json` "NEW" annotation. The file exists.
2. **Section 1:** Drop the line about `mcp/dist/` being committed. It is gitignored via the global `dist` rule.
3. **Section 1:** Drop the line about removing the committed `.mcp.json`. It is not tracked. Keep the `.mcp.json.example` reference (which is tracked).
4. **Section 7 (Backlog) item #10 (`.gitignore` hardening):** Update to: `seed.sql` and `seed-photos.tar.gz` are added to `.gitignore` in this OSS-blockers PR. Remove from the "still to do" framing.

### F. BYOK spec amendments

The BYOK spec (`2026-05-09-byok-design.md`) has fundamental misalignments that the user resolved by choosing the rip-and-replace direction (option 2). The spec's design holds; what changes is the migration framing.

1. **New section "Existing implementation being replaced" before "Schema":** Document that the current codebase already has a partial Anthropic implementation that V1 BYOK rips out and replaces:
   - `src/components/Settings.tsx` (localStorage, single-Anthropic, password input + clear) — replaced by new DB-backed multi-provider UI.
   - `src/context/SettingsContext.tsx` (localStorage write/read for `plannen_settings`) — replaced by Supabase-client-backed settings reader.
   - `supabase/functions/_shared/claude.ts` (direct-fetch Anthropic with `web_search_20250305` tool) — replaced by AI SDK wrapper at `_shared/ai.ts`.
   - Per-request `anthropic_api_key` in request body — replaced by server-side `auth.uid()` lookup in `_shared/ai.ts`.
   - Default model: Anthropic was previously `claude-opus-4-7`. V1 BYOK default is `claude-sonnet-4-6`. (See "Open question" below — confirm during implementation.)

2. **Section "Goals" amendment:** Add: "V1 deliberately moves the BYOK boundary from browser-localStorage to a DB-backed model. The existing Settings UI's privacy framing ('stored only in this browser') is replaced by 'stored in your local database, never leaves your machine in Tier 1.'"

3. **Section "Failure modes" amendment:** Existing claude.ts errors are unstructured (just thrown `Error`). New wrapper produces typed error codes per the spec's table.

4. **Open question for implementation time:** Default model — keep `claude-opus-4-7` (existing) for parity with current behaviour, or switch to `claude-sonnet-4-6` as the spec proposes (cheaper, sufficient for these workflows)? Decide when implementing; both are valid.

### G. README accuracy

The current root `README.md` (338 lines) describes V0 architecture: direct `.mcp.json` registration, BYOK key set in env. After plugin + BYOK ship, it needs updating. **Defer this to the implementation phase** — once the plugin and BYOK are built, update README in the same PR.

Specific updates needed (captured here so we don't forget):

1. **Install path:** Replace "edit `.mcp.json`" with `claude plugin install ./plugin` (when plugin is built).
2. **AI key path:** Replace "set `ANTHROPIC_API_KEY` in `mcp/.env`" with "open `/settings` in the web app and paste your key" (when BYOK migration ships).
3. **Tier framing:** Add a line near the top linking to `docs/TIERED_DEPLOYMENT_MODEL.md` and stating "this README covers Tier 1 (fully local)."
4. **License banner:** "Licensed under AGPL-3.0 — see LICENSE."
5. **Drop references to Gemini** once Gemini is fully removed per the BYOK spec.

## Implementation sequencing

This spec covers small, mostly mechanical changes. They can be done as a single PR:

1. Add `LICENSE` (AGPL-3.0).
2. Add `"license": "AGPL-3.0-only"` to both `package.json` files.
3. Delete motivation letter, `.DS_Store` from tracking. Add to `.gitignore`. Add `seed-photos.tar.gz` rule.
4. Genericize email in plugin spec. Apply plugin-spec corrections (section E). Apply BYOK-spec amendments (section F).

README polish (section G) is deferred to the implementation PR for plugin/BYOK, since the README will need substantive content updates that depend on those features existing.

## Risks & open questions

- **AGPL-3.0 deters some commercial users.** AGPL is the right choice for the monetization model but some companies have policies against AGPL-licensed dependencies. Acceptable for an end-user app; revisit only if Plannen's reusable framework (mentioned in TIERED_DEPLOYMENT_MODEL.md as a future extraction) needs broader adoption.
- **History contains the motivation letter forever.** Anyone running `git log --all -- 'umicore_*'` after release will see it. Acceptable since it's not a secret. If sensitivity changes, history rewrite remains an escape hatch (would require force-push and clone-coordination).
- **Default model choice for BYOK.** Existing code uses `claude-opus-4-7`; spec proposes `claude-sonnet-4-6`. Real implementation decision; both are workable. No blocker.
- **The `.mcp.json` local file's contents.** Currently has the maintainer's email and the demo Supabase service-role key. Not committed, so safe. The maintainer regenerates it from `.mcp.json.example` after plugin install.

## Cross-references

- `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` — plugin architecture (sections to amend per E).
- `docs/superpowers/specs/2026-05-09-byok-design.md` — BYOK design (sections to amend per F).
- `docs/TIERED_DEPLOYMENT_MODEL.md` — tier model that AGPL-3.0 supports.
- Future spec: `2026-MM-DD-bootstrap-and-setup-story-design.md` (final brainstorm topic).
