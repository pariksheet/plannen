# Tiered Deployment Model

Plannen is designed to run in four configurations, from fully local to fully hosted. The OSS code in this repo ships **Tier 1** today; the higher tiers describe where the project is heading, with Tier 3 and Tier 4 turning Plannen into an opt-in social network for events.

The underlying principle: **you decide where your data lives and who pays for the AI**.

---

## Tier 1 — Fully Local ✅ *(shipping)*

Everything runs on your computer. Nothing leaves the machine unless you trigger an AI call (which uses your own API key) or sync to Google Calendar / Google Photos (via your own OAuth credentials).

- **App** — React web app at `localhost:4321`
- **Database + storage** — local Supabase (Postgres + filesystem)
- **AI** — your own Anthropic API key, stored in the local DB and only sent to Anthropic when you trigger an AI feature
- **Sharing** — none; events stay on your machine
- **Cost to you** — your own AI usage only
- **Cost to us** — zero

This is what the [README](../README.md) walks you through.

---

## Tier 2 — Local App + Cloud Storage *(upcoming)*

The app still runs on your laptop, but data syncs to *your own* cloud accounts — so a disk failure doesn't lose everything. We never see your data.

- **App** — same local web app as Tier 1
- **Database** — your own free Supabase project (sufficient for personal use)
- **Storage** — your own Google Drive
- **AI** — same as Tier 1
- **Sharing** — still none; data lives in your accounts, not ours

Not yet implemented. Open an issue or Discussion if it'd be useful for you.

---

## Tier 3 — Local + Publish *(upcoming — social layer begins here)*

Tier 2 plus an opt-in publish mechanism. You decide *per event* whether to push it to a shared Plannen social graph where others can discover it, RSVP, comment, and bring their friends. Unpublished events stay private to your machine.

- **App** — local web app, or Claude Desktop / Claude Code via MCP
- **Database + storage** — your own (same as Tier 2)
- **Publish** — per-event opt-in, reversible
- **Sharing** — only what you publish; the rest is yours alone

This is the smallest possible step from a personal planner to a social network: data is local by default, social by choice.

---

## Tier 4 — Fully Hosted *(future — Plannen as a social network)*

A managed hosted version where you sign up, log in, and use Plannen without running anything yourself — and the social graph from Tier 3 becomes the home page. Tier 4 is where Plannen graduates from a personal tool to a network.

- **App** — hosted web app at a public URL
- **Database + storage** — hosted by us, with the same data model as Tiers 1–3
- **AI** — managed via the platform, billed per-account
- **Sharing** — public + private events, friends, groups, discovery feed
- **Trade-off** — convenience for control: your data lives on our infrastructure rather than yours

Not part of the OSS repo. If we ship Tier 4 as a commercial offering, it'll be a separate deployment of this same codebase — so Tier 1 self-hosters keep working.

---

## User Interfaces

All tiers share the same data layer. You choose your preferred interface — or use multiple:

```
                    ┌─────────────────────┐
                    │     Data Layer      │
                    │  Postgres + Storage │
                    └──────────┬──────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
│    Web App      │   │ Claude Desktop  │   │  Claude Code    │
│  browser UI     │   │  chat / MCP     │   │  CLI / MCP      │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

| Interface | Best for |
|---|---|
| Web app | Visual browsing, calendar view, photo upload, timeline |
| Claude Desktop | Natural language interaction, daily use, AI-native users |
| Claude Code | Developer / power users who build and use in the same tool |

The MCP server wraps the same service functions the web app uses, so building a feature once makes it available through all three.

---

## What's actually in this repo

Everything required for **Tier 1**: web app, MCP server, edge functions, bootstrap scripts. Tier 2/3 are direction, not on a fixed timeline; Tier 4 is not part of the OSS plan.
