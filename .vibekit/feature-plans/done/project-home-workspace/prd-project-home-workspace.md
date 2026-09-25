<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Project home workspace

> `/project/:id` becomes a real tabbed workspace — a persistent "Project" home tab plus one tab per direct agent, sharing one project-scoped tools pane — instead of a bare filtered dashboard.

**Status:** Draft
**Technical plan:** `.vibekit/feature-plans/pending/project-home-workspace/plan-project-home-workspace.md` _(link once the plan exists)_
**Follows on from:** `vst-cli-path-open-and-files` (`/project/:id` route, git-init recovery, `scope="project"` tools-pane plumbing already shipped there — this PRD reuses both rather than rebuilding them)

---

## Problem

- Opening a bare directory (`vst <path>`) lands on a `/project/:id` page with nothing actionable on it — no git-status, no way to init git, no way to start anything
- Every direct (non-worktree) agent for a project is its OWN standalone page (`/session/:id`) today — no shared tab strip, no shared tools pane between them, even though the daemon-side "project scope" already exists for files/tools
- No visible page title reflects the project you're actually looking at — the page reads as a generic dashboard, not "this project's home"

## Goals

- `/project/:id` is a tabbed workspace: a persistent "Project" tab (git status, quick actions, agent overview) plus one tab per direct agent for that project
- All tabs share ONE project-scoped tools pane (Files/Search/VCS) — already-shipped `scope="project"` plumbing, not rebuilt
- The left sidebar keeps listing direct agents under their project; clicking one opens/activates its tab in the project workspace instead of navigating to a standalone page
- Page title is the project's name, not "Dashboard"

## Non-goals

- Worktree tabs/workspace layout — unchanged, this is project(direct)-scope only
- Multi-project tab strips (tabs across different projects) — one project's workspace at a time, same as today's worktree workspace
- Changing how worktree creation itself works (git-gating etc.) — already shipped

---

## Requirements

### 1. Routing & page identity

| ID | Requirement |
|----|-------------|
| R1 | `/project/:id` opens the project workspace with the pinned home tab (labeled **"Overview"** in the shipped UI — renamed from "Project" per `plan-04-tab-sidebar-ux-fixes.md`'s naming decision, since it describes what's on the tab rather than reading as another agent) active by default. |
| R2 | `/project/:id/:sessionId` opens the project workspace with that direct agent's tab active — mirrors the existing `/worktree/:wtId/:sessionId` pattern. |
| R3 | The page title (tab bar area / browser tab) shows the project's name, never "Dashboard". |
| R4 | The standalone `/session/:id` route redirects to `/project/:projectId/:id` — one URL family for direct agents, not two. |

### 2. Project tab (home)

| ID | Requirement |
|----|-------------|
| R5 | Project tab shows git status inline: ✓ + branch name for a git project, ⚠ "Not a git repo" for a non-git one. |
| R6 | A non-git project's header shows an inline "Run git init" action — no dialog, this page IS the recovery surface. |
| R7 | "New worktree" is always visible; disabled with a tooltip pointing at "Run git init" when the project isn't git yet. |
| R8 | "New direct agent" is always visible and starts a project-scoped agent without the global draft composer. |
| R9 | Worktrees for this project keep today's status-bucket grouping (Working / Needs you / Idle / Finished). |
| R10 | Direct agents get their own "Direct agents" section on the Project tab, separate from the worktree buckets. |
| R11 | Empty state (nothing yet) foregrounds the two quick actions instead of a bare "No sessions yet" line. |

### 3. Direct-agent tabs & shared tools pane

| ID | Requirement |
|----|-------------|
| R12 | Each direct agent for the project gets its own tab (chat or terminal, same as a worktree agent tab today). |
| R13 | All tabs — Project home and every direct agent — share the SAME tools-pane instance (Files/Search/VCS), scoped to the project. |
| R14 | Opening/closing a file from any direct-agent tab is reflected in the shared tools pane immediately (already-shipped durable open-file sync applies here unchanged). |
| R15 | Clicking a direct agent in the left sidebar activates its tab in the project workspace (creating the tab if not already open), never opens a separate page. |
| R16 | Closing a direct-agent tab ends that tab's view only — it does not terminate the agent session (same convention as worktree agent tabs). |

---

## Screen layouts

### Project tab — non-git, empty

```
┌──────────────────────────────────────────────────────────────────────┐
│  scratch-nongit                                                       │  ← page title = project name
│ ┌────────────┬──────────────┬──────────────┬───┐                     │
│ │  Overview  │ (no agents yet)              │ + │                     │  ← tab strip: Overview (persistent) | agent tabs | new
│ └────────────┴──────────────┴──────────────┴───┘                     │
├──────────────────────────────────────────────────────────────────────┤
│  scratch-nongit                                    ⚠ Not a git repo  │
│  /home/vst/projects/scratch-nongit                    [ Run git init]│
│                                                                        │
│  ┌─────────────────────┐   ┌──────────────────────┐                  │
│  │  + New worktree      │   │  + New direct agent   │                  │
│  │  (needs git init)    │   │                        │                  │
│  └─────────────────────┘   └──────────────────────┘                  │
│                                                                        │
│  No worktrees or agents yet. Init git or start a direct agent to     │
│  begin.                                                                │
├───────────────────────────────────────────────┬──────────────────────┤
│                                                 │  Files │ Search │ VCS│  ← shared tools pane, project-scoped
│                                                 │  (empty — no files   │
│                                                 │   open in this       │
│                                                 │   project yet)       │
└─────────────────────────────────────────────────────────────────────┘
```

### Project tab — git project, populated

```
┌──────────────────────────────────────────────────────────────────────┐
│  northstar-api                                                        │  ← page title = project name
│ ┌────────────┬───────────────┬────────────┬───┐                      │
│ │  Overview  │ fix-typo-agent│ add-tests  │ + │                      │  ← direct-agent tabs, next to persistent Overview tab
│ └────────────┴───────────────┴────────────┴───┘                      │
├──────────────────────────────────────────────────────────────────────┤
│  northstar-api                                             ✓ main    │
│  /home/vst/projects/northstar-api                                     │
│                                                                        │
│  [ + New worktree ]   [ + New direct agent ]                          │
│                                                                        │
│  Direct agents                                                        │
│  ● fix-typo-agent            idle                                    │
│  ● add-tests                 working                                 │
│                                                                        │
│  Working                                                              │
│  ● feature-x (worktree)      ● wt-3                                  │
│                                                                        │
│  Needs you                                                            │
│  ● bugfix-y (worktree)       ● wt-5                                  │
│                                                                        │
│  ▸ Finished (3)                                                       │
├───────────────────────────────────────────────┬──────────────────────┤
│                                                 │  Files │ Search │ VCS│
│                                                 │  src/api.ts          │
│                                                 │  src/routes.ts       │
└─────────────────────────────────────────────────────────────────────┘
```

### Direct-agent tab active (e.g. "fix-typo-agent")

```
┌──────────────────────────────────────────────────────────────────────┐
│  northstar-api                                                        │  ← page title still project name, not agent name
│ ┌────────────┬───────────────┬────────────┬───┐                      │
│ │  Overview  │[fix-typo-agent]│ add-tests  │ + │                      │  ← active tab highlighted
│ └────────────┴───────────────┴────────────┴───┘                      │
├───────────────────────────────────────────────┬──────────────────────┤
│  (fix-typo-agent's chat/terminal pane, same    │  Files │ Search │ VCS│  ← SAME tools-pane instance
│   layout as a worktree agent tab today)        │  src/api.ts          │     as the Project tab — a file
│                                                 │  src/routes.ts       │     opened here shows up there too
└─────────────────────────────────────────────────────────────────────┘
```

---

## Options considered

### `/project/:id/:sessionId` vs. keeping `/session/:id` as-is

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — new `/project/:id/:sessionId`, redirect `/session/:id` to it | One URL family, mirrors `/worktree/:wtId/:sessionId` exactly, old bookmarks still work | Redirect to maintain, one extra route | ✅ chosen |
| B — keep `/session/:id` standalone, add tabs only inside `/project/:id` | No redirect needed | Two different URLs reach the "same" agent depending on entry point — confusing, breaks deep-linking from the new tab strip | ❌ deferred |

---

## Resolved design questions

1. **Does the shared tools pane need new daemon work?** — **No.** `scope="project"` file/tools plumbing already shipped in `vst-cli-path-open-and-files` (Phase 6/7) — this PRD wires the UI to reuse it, no new backend surface.
2. **What happens to a project's worktree sections on this page — do they change?** — **No, unchanged.** Same status-bucket grouping as today's dashboard, just scoped to one project and now sitting inside the Project tab rather than being the whole page.
3. **Can a direct-agent tab be closed without ending the session?** — **Yes**, same convention as worktree agent tabs today (closing a tab ≠ terminating the agent).

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|--------------------------|
| 1 | Does the sidebar's project entry need its own click target distinct from clicking a direct agent under it, to reach the Project tab vs. an agent tab? | Proposed: clicking the project name/row opens `/project/:id` (Project tab); clicking a listed direct agent opens `/project/:id/:sessionId` directly |
| 2 | Tab overflow — what happens with many direct agents (10+) for one project? | Proposed: reuse whatever overflow/scroll behavior the worktree agent tab strip already has today, no new pattern |
| 3 | Should the Project tab be pinned/un-closeable (like a browser's pinned tab), or can a user close it while agent tabs remain open? | Proposed: pinned/un-closeable — it's the only way back to git-status/quick-actions, losing it mid-session would be a dead end |
