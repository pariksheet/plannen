---
name: plannen-discovery
description: Use when the user asks an exploratory or discovery question about events to find or attend — "find me a sailing course", "any summer camps for kids in Belgium", "what's on this weekend in Brussels", "ideas for a school holiday day trip". Combines saved-source search with web search and presents merged findings with provenance. Does NOT create events — that's the intent-gate's job in plannen-core.
---

# Plannen — discovery

When the user asks a discovery or search question (e.g. "find me a sailing course for next year", "any summer camps for kids in Belgium?"):

1. **Pick 2–4 relevant tags** from the question. Lead with the specific activity (`horseriding`, `windsurfing`, `kayaking`) — not generic `sports`. Add audience (`kids`, `family`, `teens`), geography (lowercase city/country), and format (`weekend`, `residential`, `daytrip`) as relevant.

2. **Check recent visits.** Call `list_events` with `status: "past"`, `from_date` = today minus 120 days, `limit: 50`. Build a set of `{venue name, location, domain}` from the results — this is your "recently visited" filter for the rest of the flow. Without this step you will silently re-suggest places the family was at last week.

3. **Call `search_sources`** with those tags. If results are returned, fetch each `source_url` via WebFetch to look for matching events. Saved sources are organisers/platforms the user has already created events from — they're more likely to be a fit than random web results.

4. **Run a web search** for broader coverage. This catches events from organisers the user hasn't seen yet.

5. **Aggressively extract seven fields per candidate.** For every event you're about to present (from saved sources *or* the web), pull these from the page — and if missing, follow one obvious link (a "Register", "Details", "Info", or "Tickets" link) to try again:
   - **registration link** — the actual signup URL, not the landing page
   - **registration deadline** — date registration closes (or "open until full", "rolling")
   - **price** — explicitly say `free` if free; otherwise amount + currency (e.g. `€45 / child`)
   - **event date** — single date, date range, or recurring pattern
   - **address** — venue name + street + city (at minimum venue + city)
   - **age range / audience** — e.g. `8–12 yrs`, `families`, `adults only`, `all ages`
   - **language** — language(s) of instruction (e.g. `NL`, `FR`, `EN`, `NL/EN`) — matters in BE/NL

   Mark any field you genuinely can't find as `unknown` — never guess or pattern-match a plausible-sounding value. Missing fields are signal, not failure.

6. **Combine and present.** Merge findings, dedupe by URL/domain, **and apply the recent-visit filter from step 2**: drop a candidate outright when the user clearly wants something new, OR surface it as *"you were there on \<date\> — want a fresh option?"* when revisiting might still make sense (kids' venues, seasonal events). Never silently re-list a venue from the last 120 days. Note provenance: "from sources you've used before" vs. "from a web search". 3–5 results is usually enough; more is noise.

   **Render each result as a compact block** showing all five fields from step 5, with `unknown` shown plainly so the user sees the gaps:

   ```
   <Event name> — <provenance>
   • Date: 2026-07-12 → 2026-07-16
   • Address: Domein Hooidonk, Kapelstraat 12, Zandhoven
   • Ages: 8–12 yrs
   • Language: NL
   • Price: €185 / child
   • Deadline: 2026-06-01
   • Register: https://…
   ```

7. **Do not auto-create events.** The intent gate in `plannen-core` applies — wait for explicit save / book / add language before calling `create_event`. End the response with: *"Want me to save any of these as planned events?"*

## Tag examples by question shape

- "kayak weekend in Belgium" → `kayaking`, `weekend`, `belgium`
- "summer camp for kids 8–12" → `camp`, `kids`, `summer`
- "horse riding school Brussels area" → `horseriding`, `brussels`, `recurring`
- "Christmas market in the Netherlands" → `market`, `christmas`, `netherlands`
- "yoga retreat France" → `yoga`, `retreat`, `france`
