# Contributing to Plannen

Thanks for thinking about contributing. Plannen is a local-first AI planner with a Claude-driven assistant, and it gets better the more people poke at it. This document covers how to set up, how to send a change, and what kinds of changes we're looking for.

## Quick links

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Setting up to develop

The full setup is documented in the [README](README.md). The short version:

```bash
git clone https://github.com/pariksheet/plannen.git
cd plannen
bash scripts/bootstrap.sh
```

`bootstrap.sh` is idempotent — re-run it any time things drift. If something looks off later, `/plannen-doctor` (inside Claude Code) prints a targeted diagnosis.

Once it's running:

- Web app: `npm run dev` → http://localhost:4321
- Backend (Tier 0): `bash scripts/backend-start.sh` (idempotent)
- Edge functions (Tier 1 only): `bash scripts/functions-start.sh` (background)
- Umbrella: `bash scripts/start.sh` / `bash scripts/stop.sh` — tier-aware lifecycle for the whole stack.
- Tests: `npm test` (web), `cd mcp && npm test` (MCP), `cd backend && npm test` (backend), `cd supabase/functions && npm test` (pure handlers).

## Branching and PRs

We use a standard fork-and-PR flow:

1. Fork the repo on GitHub.
2. Create a topic branch off `main`: `git checkout -b fix/short-description`.
3. Make your change. Keep the commits focused — one logical change per commit reads better in review.
4. Run the local checks before pushing:
   ```bash
   npm test && npm run build
   cd mcp && npm test && npm run build && cd ..
   ```
5. Push and open a PR against `pariksheet/plannen:main`. Fill in the template.
6. CI runs the same checks on Linux + Node 20. A green pipeline is required to merge.
7. Iterate on review. Squash-merge is the default.

For anything bigger than a focused fix — a new feature, a schema change, an architectural shift — please **open an issue or a Discussion first** so we can align on scope before you spend time on code. See *What we're looking for* below.

## What we're looking for

**Welcomed — no prior discussion needed:**

- Bug fixes, with a reproducer if you can.
- Documentation improvements: README clarifications, typo fixes, missing setup steps, better error messages.
- New MCP tools that fit Plannen's local-first scope.
- New or improved plugin skills / slash commands (see [`plugin/skills/`](plugin/skills/) and [`plugin/commands/`](plugin/commands/)).
- Test coverage for existing behavior that isn't tested yet.

**Welcomed — please discuss first via an issue or Discussion:**

- Schema changes (a new migration in [`supabase/migrations/`](supabase/migrations/)). DB changes are forward-only — please read the safety notes in [`CLAUDE.md`](CLAUDE.md) and [`plugin/skills/plannen-core.md`](plugin/skills/plannen-core.md) before opening the PR.
- New user-facing features in the web app or via Claude. The bigger the surface, the more we want to sketch it together first.
- Anything touching the BYOK key path (`supabase/functions/_shared/ai.ts`, `user_settings` RLS).

**Discouraged without strong justification:**

- Major architectural rewrites of areas that just shipped (plugin architecture, BYOK).
- Features that pull Plannen away from local-first (forced cloud dependencies, telemetry, multi-tenant assumptions in Tier-1 code paths).
- Adding heavyweight dependencies for one-off use.
- New translations or i18n scaffolding — Plannen is English-only for now.

If you're not sure where your idea falls, open a [Discussion](https://github.com/pariksheet/plannen/discussions) and ask.

## Brainstorming larger changes

For substantive changes we use a lightweight design-doc workflow. Approved design docs live in [`docs/superpowers/specs/`](docs/superpowers/specs/). They tend to look like this:

- One markdown file per design, dated.
- A *Goals & non-goals* section that draws a sharp boundary.
- An *Architecture decisions* table that records what was picked and what was rejected, so future readers can see the reasoning.
- A *Risks* section.

You don't have to use this format — but if your PR touches multiple files, several layers, or anything irreversible, a short doc up front saves everyone a lot of back-and-forth in review. Drop it in `docs/superpowers/specs/YYYY-MM-DD-your-topic.md` and link it from the PR.

## Commit messages

Imperative present tense, conventional-style prefix when it helps:

```
fix(mcp): handle null taken_at when sorting event memories
feat(stories): support Dutch as a story output language
docs(readme): correct supabase port in troubleshooting
```

A short body explaining *why* the change is needed is welcome — the *what* is in the diff.

## Tests

- Web app uses Vitest + Testing Library; tests live next to the code they cover or in `tests/`.
- MCP uses Vitest; tests live in `mcp/tests/`.
- Please add a test for any bug you fix (so it stays fixed) and for any non-trivial new behavior.

We don't require 100% coverage, but the CI build must stay green.

### Smoke testing the CLI provider

`scripts/smoke-cli-provider.sh` verifies the `claude` binary is reachable and produces the expected JSON wrapper. Run it locally after touching anything in `backend/src/_shared-overlay/providers/claude-cli.ts` or `run-cli.ts`. Not part of CI (no real-binary tests run in CI).

## Reporting bugs and asking questions

- **Bug?** Open an [issue](https://github.com/pariksheet/plannen/issues/new/choose) with the bug template.
- **Idea or feature request?** Use the feature template, or open a [Discussion](https://github.com/pariksheet/plannen/discussions) first if you want to bounce it around.
- **Question?** [Discussions Q&A](https://github.com/pariksheet/plannen/discussions/categories/q-a) is the right place.
- **Security vulnerability?** Don't open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under [AGPL-3.0-only](LICENSE), the same license that covers the rest of the project.
