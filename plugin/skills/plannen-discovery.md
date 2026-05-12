---
name: plannen-discovery
description: Use when the user asks an exploratory or discovery question about events to find or attend — "find me a sailing course", "any summer camps for kids in Belgium", "what's on this weekend in Brussels", "ideas for a school holiday day trip". Combines saved-source search with web search and presents merged findings with provenance. Does NOT create events — that's the intent-gate's job in plannen-core.
---

# Plannen — discovery

When the user asks a discovery or search question (e.g. "find me a sailing course for next year", "any summer camps for kids in Belgium?"):

1. **Pick 2–4 relevant tags** from the question. Lead with the specific activity (`horseriding`, `windsurfing`, `kayaking`) — not generic `sports`. Add audience (`kids`, `family`, `teens`), geography (lowercase city/country), and format (`weekend`, `residential`, `daytrip`) as relevant.

2. **Call `search_sources`** with those tags. If results are returned, fetch each `source_url` via WebFetch to look for matching events. Saved sources are organisers/platforms the user has already created events from — they're more likely to be a fit than random web results.

3. **Run a web search** for broader coverage. This catches events from organisers the user hasn't seen yet.

4. **Combine and present.** Merge findings, dedupe by URL/domain, and note provenance: "from sources you've used before" vs. "from a web search". 3–5 results is usually enough; more is noise.

5. **Do not auto-create events.** The intent gate in `plannen-core` applies — wait for explicit save / book / add language before calling `create_event`. End the response with: *"Want me to save any of these as planned events?"*

## Tag examples by question shape

- "kayak weekend in Belgium" → `kayaking`, `weekend`, `belgium`
- "summer camp for kids 8–12" → `camp`, `kids`, `summer`
- "horse riding school Brussels area" → `horseriding`, `brussels`, `recurring`
- "Christmas market in the Netherlands" → `market`, `christmas`, `netherlands`
- "yoga retreat France" → `yoga`, `retreat`, `france`
