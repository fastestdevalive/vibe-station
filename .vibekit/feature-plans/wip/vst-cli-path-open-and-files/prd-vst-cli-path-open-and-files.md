<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: vst-cli path open/create + open-file management

> Bare-path project shorthand for `vst`, git-gated worktree creation with a UI recovery path, and CLI visibility/control over open files.

**Status:** Approved
**Technical plan:** `.vibekit/feature-plans/pending/vst-cli-path-open-and-files/plan-vst-cli-path-open-and-files.md` _(link once the plan exists)_

---

## Problem

- `vst open <path>` requires typing the subcommand, fails instead of registering an unknown project, and even on success still lands the user on the dashboard instead of that project's own view
- Worktree creation has no defined behavior when the target project isn't a git repo — CLI and UI both need one, and they need different UX
- Agents have no way to see or control how many files are open in their scope — only the UI shows/edits open-file state today

## Goals

- Typing `vst <path>` opens or creates a project at that path, git or not, in its own new app window on the same daemon
- A real subcommand name always wins over path interpretation — no ambiguity
- Worktree creation on a non-git project fails clearly everywhere, but the web UI offers a one-click recovery instead of forcing a restart
- Agents can query and manage open files entirely from the CLI

## Non-goals

- Any other "recoverable precondition failure" case beyond the non-git-worktree one (see Open Questions)
- New file-viewing/editing capability beyond open/close/list state

---

## Requirements

### 1. Bare-path project open/create

| ID | Requirement |
|----|-------------|
| R1 | Running `vst <path>` opens the project at that path, creating and registering it first if not yet known. |
| R2 | `vst <path>` lands on that project's own view, never the dashboard. |
| R3 | `vst <path>` opens the project in a new vibe-station app window backed by the already-running daemon, rather than replacing the current window's contents. |
| R4 | Project creation succeeds for a target directory that is not a git repository. |
| R5 | If the target path doesn't exist on disk at all, `vst <path>` errors by default; `vst <path> --force-create` creates the directory (and the project) instead. |
| R6 | A relative path resolves against the current working directory. |

### 2. Subcommand vs. path precedence

| ID | Requirement |
|----|-------------|
| R7 | If the first word matches a real subcommand name, it always dispatches as that subcommand; only when a directory of that same name also exists does the CLI hint at the explicit `vst open <name>` form to reach it. |

### 3. Git-gated worktree creation

| ID | Requirement |
|----|-------------|
| R8 | Creating a worktree from the CLI on a non-git project fails immediately with a clear error — no prompt, no automatic `git init`. |
| R9 | Creating a worktree from the web UI on a non-git project shows a dialog explaining the repo isn't git-initialized and offers a "Run git init" action. |
| R10 | Accepting that action initializes git in place, then proceeds directly to worktree creation without the user repeating the flow. |
| R11 | A project whose directory becomes a git repo after it was registered as non-git allows worktree creation from then on, with no need to re-add the project. |

### 4. Open-file visibility & management

| ID | Requirement |
|----|-------------|
| R12 | An agent can list, open, and close files from the CLI, scoped to its worktree or project, reflected in the same open-file state the web UI shows. |

---

## Options considered

### Bare-path invocation shape

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — `vst <path>` as shorthand alias for existing `vst open <path>` | No new concept, minimal surface, reuses proven logic | Precedence rule needed vs. real subcommands | ✅ chosen |
| B — New dedicated top-level command | No precedence ambiguity | Redundant with `vst open`, more surface to maintain | ❌ deferred |

### Non-git worktree creation UX

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Same hard-error behavior on both CLI and web UI | Simple, one behavior to reason about | UI users forced to leave the flow, run `git init` manually, restart | ❌ deferred |
| B — CLI hard-errors; web UI offers inline "Run git init" recovery | Matches each surface's strengths (CLI scriptable/non-interactive, UI can recover inline) | Two different behaviors to document and test | ✅ chosen |

---

## Resolved design questions

1. **Does `vst <path>` replace `vst open`?** — **No, it's a bare-shorthand alias.** `vst open <path>` keeps working unchanged; `vst <path>` dispatches to the same logic whenever the first word typed isn't a known subcommand.
2. **What happens when a directory is literally named after a subcommand (e.g. `open`)?** — **The subcommand always wins.** User disambiguates with the explicit `vst open <name>` form.
3. **Should worktree creation on a non-git project ever silently auto-init?** — **No, never automatically, and never on the CLI at all.** CLI always hard-errors with no prompt; only the web UI offers an explicit, user-initiated recovery action.
4. **Does accepting "Run git init" in the UI dialog restart the worktree-creation flow?** — **No.** It runs `git init`, then proceeds straight into worktree creation with the same inputs already given.
5. **When is a project's git-ness determined?** — **Once, at project-creation time, and remembered from then on** (not re-checked on every worktree attempt), except when the project transitions from non-git to git (R9), which updates the remembered value.
6. **What scope resolves "open files" for a project-level (non-worktree) session?** — **A project-wide open-file set** — the natural analogue of worktree scope when there's no worktree.
7. **If `vst <path>` targets a directory that doesn't exist on disk at all, does it create the directory, or error?** — **Errors by default; `--force-create` opts in to creating it** — matches the general convention that editor CLIs don't silently create missing folders on open.
8. **Does `vst <path>` reuse the current app window, or open a new one?** — **Opens a new window, backed by the same running daemon.** New behavior, not a pre-existing one to confirm — today's app opens exactly one window and navigates it in place.

---

## Screen layouts

### Non-git worktree creation error (web UI)

```
┌──────────────────────────────────────┐
│  Can't create worktree                │  ← dialog title
│                                        │
│  This project isn't a git repository, │  ← explanation
│  so a worktree (an isolated branch    │
│  checkout) can't be created here.     │
│                                        │
│  ┌──────────────────────────────┐    │
│  │   Run git init and continue  │    │  ← primary action
│  └──────────────────────────────┘    │
│  ┌──────────────────────────────┐    │
│  │   Cancel                     │    │  ← secondary
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

Notes:
- "Run git init and continue" initializes git in the project directory, then proceeds with the original worktree-creation request unchanged
- "Cancel" closes the dialog with no changes; the worktree-creation flow does not run

---

## Priority & sequencing

| Order | Sub-feature | Depends on | Can ship independently? |
|-------|-------------|------------|--------------------------|
| 1 | Bare-path open/create + subcommand precedence | — | Yes |
| 2 | Git-gated worktree creation (CLI + UI recovery) | Sub-feature 1 (a project must already know whether it's git-backed) | Yes |
| 3 | Open-file CLI management (`vst files ls\|open\|close`) | — | Yes |

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|--------------------------|
| 1 | **Are there other "recoverable precondition failure" cases (UI offers inline fix, CLI hard-errors) worth the same treatment?** | Likely yes — not scoped here, flag for a future pass once this pattern ships once |
