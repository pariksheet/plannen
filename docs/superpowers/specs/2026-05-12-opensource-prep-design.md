# Plannen Open-Source Launch Prep — Design

**Date:** 2026-05-12
**Status:** Design approved; pending spec review and implementation plan
**Branch:** `feat/prepare-opensource`
**Related:** `2026-05-09-oss-blockers-design.md`, `2026-05-09-plannen-plugin-architecture-design.md`, `2026-05-09-byok-design.md`

## Context

The May 2026 OSS-blockers work (AGPL-3.0 license, plugin architecture, BYOK migration, README rewrite, motivation-letter removal, `.gitignore` hardening) landed the structural prerequisites for a public release. This spec covers what's left between "OSS-ready code in a private repo" and "polished public launch with an inviting contributor posture."

Three things drive the design:

1. **Stance:** welcoming maintainer — actively want PRs and issues, with proper contributor scaffolding.
2. **Posture:** polished launch (Show-HN-ready) — logo, screenshot, GIF, social card.
3. **History:** rewrite to a single Initial Commit at release — old commits contain a deleted personal motivation letter and exploratory work that's not interesting to a fresh audience.

## Goals & non-goals

### Goals

1. Repo is public, AGPL-3.0, with one commit on `main` (Initial Commit) tagged `v0.1.0`.
2. A first-time visitor sees a logo, a screenshot of the web app, and a short demo GIF of a Claude Code session above the fold of the README.
3. Anyone reading README + CONTRIBUTING can clone, bootstrap, run, and submit a PR without asking a question.
4. CI runs `npm test`, `npm run build`, `mcp/npm test`, `mcp/npm run build` on every PR; failures block merge.
5. Vulnerability reports flow through GitHub Security Advisories only — no email exposed.
6. GitHub repo has: description, topic tags, Issues enabled, Discussions enabled, three issue templates (bug / feature / question), a PR template.

### Non-goals

- Marketing site / landing page. Homepage URL stays blank on GitHub.
- Multi-OS or multi-Node CI matrix. Linux + Node 20 only.
- Pre-launch advocacy (Show HN, Reddit, social) — separate effort.
- New product features. If we find a bug while writing docs, we file it, we don't fix it.
- Translation. English only.
- A `1.0.0` release. V1 launches as `v0.1.0`.

## Architecture decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Sequencing | Two milestones (M1 deterministic / M2 visuals + irreversible) with a checkpoint merge between | Single push (no checkpoint, visuals can stall everything); parallelize via subagents (text work is fast enough that parallelism doesn't help). |
| Contributor stance | Welcoming maintainer — full CONTRIBUTING, Contributor Covenant 2.1 CoC, three issue templates, PR template, Discussions enabled | Source-available light interaction (undersells the project); showcase/archive (incompatible with PRs welcomed). |
| CI scope | Standard — tests + build for both web and mcp; Linux + Node 20 only | Lean (no build = misses type errors); thorough (Node matrix + supabase smoke = slower, flakier, premature). |
| Security contact | GitHub Security Advisories only | Email + advisories (email harvesting); email only (no private workflow). |
| Backlog directory | Delete after local backup; roll active files into `ROADMAP.md` | Keep tracked (looks like personal scratchpad); delete with no roadmap (loses contributor onboarding signal). |
| Logo | AI-generated icon + SVG wordmark; placed in README hero, favicon, web-app top bar, social card | Minimal SVG wordmark (less identity); custom designed (cost/time); emoji stand-in (less polished). |
| Demo media | One static screenshot + one short Claude Code GIF | Skip (weakens first impression); screenshot only (doesn't show the AI path). |
| GIF tool | `vhs` (deterministic, scriptable); fallback to QuickTime + ffmpeg if Claude Code UI doesn't render cleanly in vhs | Screen-record only (not reproducible); asciinema (no rich UI). |
| Release tag | `v0.1.0` | `v1.0.0` (oversells stability for a first public release). |
| Order of operations | Wipe history *before* flipping public | Any other order risks a force-push affecting a public audience. |

## M1 — Deterministic deliverables

Branch: `feat/prepare-opensource`. All work commits to this branch; merge to `main` when done. Repo stays private through M1.

### M1.A — Contributor documentation (new files)

| File | Content | Size |
|---|---|---|
| `CONTRIBUTING.md` | Dev setup (link to README), branch flow (fork → branch → PR), PR expectations (passing CI, clear description, scope discipline). Welcomed contribution types: bug fixes, doc improvements, new MCP tools, plugin skills. Discouraged without prior discussion: major architectural rewrites, features outside the local-first scope. Reference to `docs/superpowers/specs/` brainstorming workflow for larger changes. | ~150-200 lines |
| `CODE_OF_CONDUCT.md` | Verbatim [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Contact line replaced with: "report via [GitHub Security Advisories](https://github.com/pariksheet/plannen/security/advisories/new)." | ~130 lines |
| `SECURITY.md` | Supported versions: latest `main` only. Reporting path: GitHub Security Advisories link. Acknowledgement SLA: within 7 days. No email contact. | ~30 lines |

### M1.B — GitHub scaffolding (new `.github/` directory)

| File | Purpose |
|---|---|
| `.github/ISSUE_TEMPLATE/bug.yml` | Form-style: title, what happened, repro, expected, env (OS, Node, supabase versions). Auto-label `bug`. |
| `.github/ISSUE_TEMPLATE/feature.yml` | Title, problem, proposed solution, alternatives considered. Auto-label `enhancement`. |
| `.github/ISSUE_TEMPLATE/question.yml` | Redirects to Discussions; if user insists, short form. Auto-label `question`. |
| `.github/ISSUE_TEMPLATE/config.yml` | Disables blank issues. Adds contact links to Discussions Q&A and Security Advisories. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Summary, why, test plan, breaking changes (yes/no), checklist (CI green, docs updated, spec linked if applicable). |
| `.github/workflows/ci.yml` | One job on `ubuntu-latest`, Node 20: checkout → `npm ci` → `npm test` → `npm run build` → `cd mcp && npm ci && npm test && npm run build`. Triggers on `push` to `main` and `pull_request` to `main`. |

### M1.C — Top-level files (new)

| File | Purpose |
|---|---|
| `CHANGELOG.md` | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. One entry: `## [0.1.0] - 2026-MM-DD — Initial public release.` Bullet list of what ships (web app, MCP server, plugin, AGPL-3.0). Date filled in at release time. |
| `ROADMAP.md` | Collapses the 4 active `backlog/*.md` files (`discovery-engine`, `event-memories`, `registration-payment`, `stories`) into "Planned" + "Considering" sections. Brief "Shipped" section from `backlog/completed/`. ~80-120 lines. |

### M1.D — `package.json` edits (root and `mcp/`)

- `"author": { "name": "Pari", "url": "https://github.com/pariksheet" }` — no email; matches Advisories-only contact policy.
- `"repository": { "type": "git", "url": "https://github.com/pariksheet/plannen.git" }`
- `"bugs": { "url": "https://github.com/pariksheet/plannen/issues" }`
- `"homepage": "https://github.com/pariksheet/plannen#readme"`

### M1.E — Cleanup (no file changes)

```bash
cp -r backlog/ ~/plannen-backlog-backup-2026-05-12/
git rm -r backlog/
git branch -D claude/ecstatic-jepsen-aca7ca claude/wizardly-liskov-394c4a
```

### M1 closing step

Merge `feat/prepare-opensource` to `main`. Push. Repo remains private. Create `feat/prepare-opensource-visuals` for M2.

## M2 — Visual deliverables and launch

Branch: `feat/prepare-opensource-visuals`. Mixed agent + human workflow.

### M2.A — Logo set

Generation flow:

1. Agent drafts 3-5 image-model prompts targeting a small symbolic mark (calendar+sparkle, planner+leaf, abstract grid). Style direction: friendly, minimal, single accent color, legible at 32×32.
2. User runs prompts through preferred image model (DALL-E, Midjourney, Imagen, or Claude's image features) and shares results.
3. Iterate up to 3 rounds. If no winner by round 3, fall back to a minimal SVG wordmark (no icon).
4. Agent assembles the SVG wordmark in-repo (Inter or similar typeface, `<text>` element) and pairs with the chosen icon.

Deliverables (committed):

- `public/logo.svg` — full lockup (icon + wordmark), README hero.
- `public/favicon.svg` — icon-only, browser tab.
- `public/og-image.png` — 1200×630, icon + wordmark + tagline on tinted background. Social card.
- `src/components/Logo.tsx` (or header update) — replaces "Plannen" text in web-app top bar.
- `index.html` — adds `<link rel="icon">`, `og:image`, `twitter:card` meta tags.

### M2.B — Screenshot

User-captured at `localhost:5173` once local DB has demo-clean data:

- Monthly calendar view.
- 5-8 events visible, mix of past and upcoming.
- No real personal entries the user doesn't want public.
- ~1080p PNG, exact crop spec finalized at capture time.
- Committed to `docs/images/screenshot-app.png`.

### M2.C — Demo GIF

Tool: [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`).

Scenario: ~10 seconds of a Claude Code session. User types a prompt ("schedule swim class for Saturday morning" or similar real use case to be finalized at capture time); intent gate fires; event is created via MCP. Output: `docs/images/demo.gif`, ~600px wide, optimized for GitHub README.

Fallback if `vhs` doesn't capture Claude Code's UI cleanly: QuickTime / OBS screen capture → `ffmpeg` conversion. The `.tape` file (or capture procedure) is checked in for reproducibility.

### M2.D — README wiring

Inject above the existing `## Prerequisites`:

```markdown
<p align="center">
  <img src="public/logo.svg" alt="Plannen" width="320">
</p>

<p align="center"><em>Local-first family planner with a built-in AI assistant.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License"></a>
  <a href="https://github.com/pariksheet/plannen/actions/workflows/ci.yml"><img src="https://github.com/pariksheet/plannen/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <img src="docs/images/screenshot-app.png" alt="Plannen calendar view" width="720">
</p>

<p align="center">
  <img src="docs/images/demo.gif" alt="Asking Claude to schedule an event" width="600">
</p>
```

### M2.E — GitHub repo metadata

```bash
gh repo edit pariksheet/plannen \
  --description "Local-first family planner with a built-in AI assistant. Your data stays on your machine. Bring your own Claude key." \
  --add-topic local-first \
  --add-topic family-planner \
  --add-topic claude \
  --add-topic mcp \
  --add-topic mcp-server \
  --add-topic claude-code \
  --add-topic agpl-3 \
  --add-topic supabase \
  --add-topic react \
  --add-topic typescript \
  --add-topic byok \
  --enable-issues \
  --enable-discussions
```

### M2.F — Final merge of visuals

Merge `feat/prepare-opensource-visuals` to `main` when visuals are locked.

### M2.G — History wipe (irreversible)

Pre-wipe safety net: tag the current `main` locally as `backup/pre-opensource-wipe` (NOT pushed). Reflog provides a second safety net for ~90 days.

```bash
git tag backup/pre-opensource-wipe main
git checkout --orphan fresh-main
git commit -m "Initial commit"
git branch -D main
git branch -m fresh-main main
git push --force origin main
git tag v0.1.0
git push origin v0.1.0
git gc --prune=now --aggressive
```

### M2.H — Flip public

```bash
gh repo edit pariksheet/plannen --visibility public --accept-visibility-change-consequences
```

### M2.I — Launch verification

Open the public URL in an incognito window. Verify:

- Logo renders in README.
- Screenshot renders.
- GIF plays.
- CI badge resolves and shows passing.
- License / Issues / Discussions tabs present.
- Social card renders via [opengraph.xyz](https://www.opengraph.xyz/).

## Risks

1. **History wipe is one-way on the remote.** Mitigation: wipe runs *before* the public flip, so there's no clone audience yet. Local `backup/pre-opensource-wipe` tag + reflog provide recovery paths for ~90 days.
2. **Logo iteration can stall launch.** Mitigation: cap at 3 iteration rounds; fall back to minimal SVG wordmark if no winner emerges.
3. **GIF dates fast.** Mitigation: check in the `.tape` file so re-recording is one command; document regenerability in CONTRIBUTING.
4. **CI may fail on first push.** Mitigation: validate locally with [`act`](https://github.com/nektos/act) before merging M1, or accept one fix-up commit on `main` post-merge.
5. **AGPL deters commercial adopters.** Acknowledged in prior `2026-05-09-oss-blockers-design.md`; acceptable trade-off for the monetization model.
6. **Backlog deletion loses planning work.** Mitigation: explicit local backup before `git rm -r`; active backlog content rolls into `ROADMAP.md`.

## Open questions

1. **Tag version: `v0.1.0` vs `v1.0.0`.** Default in this spec: `v0.1.0`. Decide before the tag step in M2.G.
2. **Discussions categories.** Keep GitHub defaults at launch; prune later if any go unused.
3. **Logo color direction.** Defer until 2-3 generations exist to compare; agent will propose a palette set during M2.A.
4. **Demo GIF scenario.** "Schedule swim class for Saturday morning" is illustrative; finalize the real prompt during M2.C.

## Order-of-operations invariant

> Anything requiring a public audience comes *after* the history wipe.

Specifically: wipe → tag `v0.1.0` → flip public → announce. Never the reverse. If second thoughts arise during M2, stop after the wipe — `main` will be a clean single-commit private repo, and the public flip can happen at any later time.

## Cross-references

- `docs/superpowers/specs/2026-05-09-oss-blockers-design.md` — preceding OSS-readiness work (license, plugin, BYOK, README, .gitignore).
- `docs/superpowers/specs/2026-05-09-plannen-plugin-architecture-design.md` — plugin architecture (shipped).
- `docs/superpowers/specs/2026-05-09-byok-design.md` — BYOK design (shipped).
- `docs/TIERED_DEPLOYMENT_MODEL.md` — tier model.
