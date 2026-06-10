---
description: Cut a release — bump version (package + plugin in lockstep), draft CHANGELOG, PR, squash-merge, tag, and publish a GitHub Release. Fully automated.
argument-hint: "[patch|minor|major|X.Y.Z]  (default: patch)"
---

The user invoked `/release $ARGUMENTS`. Cut a full release end-to-end, fully automated. The bump argument is `$ARGUMENTS` — a keyword (`patch`, `minor`, `major`) or an explicit version (`X.Y.Z`). **Default to `patch` when empty.**

Run the phases in order. Pre-flight failures **abort cleanly** (nothing pushed) — they do not pause for the user. Report what aborted and why.

## Phase 1 — Pre-flight (abort on any failure)

```bash
cd /Users/stroomnova/Music/plannen
gh auth status        # abort if not authenticated
git status --short     # MUST be empty — feature work is already committed
```

- If the working tree is **not** clean, abort: "Working tree dirty — commit your feature work before releasing." (The release command only authors version/CHANGELOG changes.)
- Read the current version: `node -p "require('./package.json').version"`.
- Compute the **target** version from the argument (patch bump if empty). Keep both `OLD` and `NEW` in hand.
- Abort if the tag already exists: `git rev-parse "v$NEW" 2>/dev/null` succeeds, or `git ls-remote --tags origin "v$NEW"` is non-empty → "v$NEW already exists."
- **Release gate** — run and abort on failure:
  ```bash
  npx tsc --noEmit && npm run test:run
  ```
- Branch: if on `main`, cut `git checkout -b release/v$NEW`. If already on a feature branch, stay on it (the release commit rides along with the feature).

## Phase 2 — Version bump (package and plugin move together)

Use `npm version` for the package files — it edits `package.json` **and** `package-lock.json` without reformatting and without tagging:

```bash
npm version "$NEW" --no-git-tag-version   # pass the explicit NEW you computed
```

Then bump the plugin manifest(s) to the **same** version with sed (the plugin version is always set equal to the package version — this is the consistency guarantee, the plugin may currently be on a different number):

```bash
sed -i '' -E "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1$NEW\2/" plugin/.claude-plugin/plugin.json.example
# Local, gitignored — bump if present so the running plugin matches:
[ -f plugin/.claude-plugin/plugin.json ] && sed -i '' -E "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1$NEW\2/" plugin/.claude-plugin/plugin.json
```

Only `package.json`, `package-lock.json`, and `plugin/.claude-plugin/plugin.json.example` are tracked — those go in the commit. `plugin.json` is gitignored.

## Phase 3 — CHANGELOG

Draft a new section from the branch's commits since the last tag:

```bash
git log "$(git describe --tags --abbrev=0)..HEAD" --pretty="%s%n%b"
```

Write a `## [$NEW] - <today>` section (today = the date from session context, `YYYY-MM-DD`) and insert it **directly below** the `## [Unreleased]` line in `CHANGELOG.md`. Match the existing house style: a short `### <theme>` heading, then `- **Bolded lead.** explanation` bullets. Summarize the *user-visible* effect of each change — don't just paste commit subjects. **Never put personal data in the CHANGELOG** (this repo is public; use generic phrasing).

## Phase 4 — Commit, PR, squash-merge

```bash
git add CHANGELOG.md package.json package-lock.json plugin/.claude-plugin/plugin.json.example
git commit -m "$(cat <<'EOF'
release: <NEW> — <one-line summary>

<2–3 line body summarizing the release>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
git push -u origin HEAD
gh pr create --title "release: <NEW> — <summary>" --body "<PR body: Summary bullets + Test plan. End with the Generated-with line.>"
gh pr merge --squash --delete-branch
```

## Phase 5 — Tag and publish the GitHub Release

A tag is **not** a Release — both are required, this is the step that was missed before.

```bash
git checkout main && git pull --ff-only origin main
git tag -a "v$NEW" -m "release: $NEW — <summary>"
git push origin "v$NEW"
# Notes = the CHANGELOG section for this version:
awk "/^## \\[$NEW\\]/{f=1;next} /^## \\[/{if(f)exit} f" CHANGELOG.md > /tmp/release-notes-$NEW.md
gh release create "v$NEW" --title "v$NEW — <summary>" --notes-file /tmp/release-notes-$NEW.md --latest
```

## Phase 6 — Report

Print: old → new version, PR link, tag `v$NEW`, and the GitHub Release URL. Confirm the package and plugin versions now match.

## Notes

- Semver bump from `OLD`: `patch` → bump Z; `minor` → bump Y, Z=0; `major` → bump X, Y=Z=0. An explicit `X.Y.Z` argument is used verbatim (still abort if its tag exists).
- If `gh pr merge --squash` fails because branch protection requires checks, report the PR link and stop — the user merges, then re-run only Phase 5 (`/release` is not safe to re-run wholesale once the version is bumped).
- This command lives in the repo (`.claude/commands/`), not the plugin — it's a maintainer tool and must never ship to plugin users.
