# Release notes format

Each release has a hand-curated notes file at `.github/release-notes/<tag>.md`
(for example `v0.0.1-beta.md`). `release.yml` publishes it as the GitHub Release body. If the file for
a tag does not exist, the workflow falls back to GitHub's auto-generated notes (a flat PR list).

## Rules

- **3-4 sections.** Each is a `###` header followed by 3-6 bullets.
- **No intro, no "Highlights", no global summary section.** The first line of the file is the first section header.
- **One short sentence per bullet.** Say one concrete capability or change; no marketing wording, no PR
  numbers, no root-cause write-ups.
- **No emojis.**
- **Group by what the user sees**, not by commit type. Typical sections:
  - Agents and sessions
  - Workspace and code navigation
  - Interfaces
  - Install
  For later releases, swap in sections that fit the changes (for example "Fixes and stability",
  "Known limitations") but stay within 3-4.
- **Only claim what is verified in the code or tested.** Drop a bullet rather than guess.

## Workflow

1. Draft the file from `git log <previous-tag>..HEAD` (conventional commits help: `feat` and `fix` carry most of it).
2. Edit it down to the rules above and commit it before tagging.
3. Tag and push; `release.yml` picks the file up by tag name.

Template: see `.github/release-notes/v0.0.1-beta.md`.
