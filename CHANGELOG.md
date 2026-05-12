# Changelog

All notable changes to Plannen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-MM-DD

Initial public release. Plannen ships as a local-first AI planner that learns your preferences and turns events into memories, licensed under [AGPL-3.0](LICENSE).

### Added

- **Web app** — React + Vite calendar UI for events, family members, locations, RSVPs, memories, and stories.
- **MCP server** — single-file TypeScript wrapper that lets Claude Code and Claude Desktop read and write a local Plannen instance via Supabase.
- **Claude Code plugin** — installable via `/plugin install ./plugin`, bundling MCP registration, workflow skills (event-creation intent gate, profile extraction, source analysis, watch monitoring, story composition, photo organisation, discovery), and slash commands.
- **Slash commands** — `/plannen-doctor`, `/plannen-setup`, `/plannen-write-story`, `/plannen-organise-photos`, `/plannen-discover`, `/plannen-check-watches`, `/plannen-backup`.
- **BYOK AI keys** — per-user Anthropic API key stored in the local Supabase `user_settings` table, used server-side by edge functions; never sent on requests.
- **Bootstrap script** — `scripts/bootstrap.sh` performs a one-command first-run install: prereq checks, npm install, supabase start, migrations, auth-user creation, env-file generation, and optional plugin install.
- **Backup tooling** — `scripts/export-seed.sh` writes `supabase/seed.sql` and `supabase/seed-photos.tar.gz`; `scripts/restore-photos.sh` rebuilds storage objects with the xattrs the Supabase storage worker expects.
- **Google Photos integration** — picker-based attachment of photos to events via the Photos Library API.
- **Google Calendar sync** — outbound sync candidates surfaced via `get_gcal_sync_candidates`.
- **Stories** — AI-generated narratives for past events, multi-language (English, Marathi, Dutch by default).
- **Watch monitoring** — periodic re-check of saved event sources for date/registration changes.
- **CI** — GitHub Actions workflow runs web and MCP tests + builds on every PR (Linux + Node 20).
- **Contributor docs** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue and PR templates.

[Unreleased]: https://github.com/pariksheet/plannen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pariksheet/plannen/releases/tag/v0.1.0
