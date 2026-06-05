# Security Policy

## Supported versions

Plannen tracks a single supported line: the latest `main`. Security fixes land on `main` and become part of the next tagged release. We don't backport to older tags.

| Version | Supported |
|---------|-----------|
| `main` (latest)   | ✅ |
| Older tagged releases | ❌ |

## Reporting a vulnerability

**Please don't open a public issue for security reports.**

Use [GitHub Security Advisories](https://github.com/pariksheet/plannen/security/advisories/new) to report privately. This keeps the report visible only to maintainers until a fix is available.

Include:

- A description of the issue and the potential impact.
- Steps to reproduce, or a proof-of-concept if you have one.
- The commit SHA or version you tested against.
- Whether you'd like to be credited in the advisory once it's published.

### What to expect

- **Acknowledgement** within 7 days. If you haven't heard back by then, the report may have slipped — please nudge by adding a comment to the advisory.
- **Triage and remediation** timing depends on severity and complexity. We'll keep you posted in the advisory thread.
- **Coordinated disclosure**: we publish the advisory once a fix is released on `main`. Credit goes to the reporter unless you ask otherwise.

## Scope

In scope:

- The web app (`src/`), MCP server (`mcp/`), edge functions (`supabase/functions/`), bootstrap and helper scripts (`scripts/`), and the Claude Code plugin (`plugin/`).
- Authentication, data-handling, secret-management, and BYOK-AI-key paths.

Out of scope:

- Issues in upstream dependencies (Supabase, React, Vite, the MCP SDK, Anthropic's Claude clients). Report those to the upstream project; if Plannen surfaces or amplifies the issue in a way an upstream fix won't address, do report it here.
- Self-inflicted misconfigurations (e.g. committing your own `.env`, exposing your Supabase port on a public network).
- Findings that depend on the attacker already having root or full filesystem access on the same machine — Plannen is a local-first app and trusts the host it runs on.
