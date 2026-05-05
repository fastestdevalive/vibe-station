# vibe-station

**Orchestrate parallel AI coding agents from a single web UI.**

vibe-station lets you spawn multiple AI coding agents (Claude Code, Cursor, OpenCode) working simultaneously on isolated git branches — each with its own worktree, terminal, and file preview — all managed from your browser.

Instead of juggling tmux tabs and editor windows, you get a unified interface where every agent runs in its own branch, streams its output live, and can be messaged, paused, or replicated with a single command.

---

## What it does

- **Parallel agents** — run Claude Code, Cursor, and OpenCode side-by-side on separate branches
- **Isolated worktrees** — each agent gets its own `git worktree` checkout, so they never conflict
- **Live terminal streaming** — watch agents work in real time, send messages mid-task
- **File preview** — browse the working tree, view diffs, render markdown and diagrams
- **CLI + web UI** — `vst` for scripting and automation, browser UI for interactive oversight
- **Session persistence** — agents survive daemon restarts; Claude sessions resume with full history

---

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9 — `npm install -g pnpm`
- **tmux** — `brew install tmux` / `apt install tmux`
- **git** ≥ 2.5 (worktree support)
- At least one AI CLI installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.sh), or [OpenCode](https://opencode.ai)

---

## Installation

```bash
# Clone the repo
git clone https://github.com/your-org/vibe-station.git
cd vibe-station

# Install dependencies
pnpm install

# Build everything (CLI + web)
pnpm build

# Link the CLI globally so `vst` is available anywhere
pnpm link --global
# — or add cli/dist to your PATH
```

Verify it works:

```bash
vst --version
vst doctor        # checks tmux, git, and installed AI CLIs
```

---

## Quick start

### 1. Start the daemon

The daemon manages all state, worktrees, and tmux sessions. It runs locally on `localhost:7421`.

```bash
vst daemon start
```

It starts in the background and writes its port + PID to `~/.vibe-station/config.json`. Any `vst` command will also auto-start the daemon if it isn't running.

### 2. Register a project

Point vibe-station at a git repository:

```bash
vst project add /path/to/your/repo --name=my-app
```

The `--name` flag sets the project ID you'll use in other commands. If omitted, it's inferred from the directory name.

### 3. Create a mode

A **mode** pairs an AI CLI with an optional system context. You need at least one before spawning agents.

```bash
vst mode add --name="Claude Coder" --cli=claude --context="You are an expert TypeScript engineer."
```

Supported `--cli` values: `claude`, `cursor`, `opencode`.

List your modes:

```bash
vst mode ls
```

### 4. Create a worktree

A worktree is an isolated branch + agent session combo. Creating one atomically checks out a new branch and spawns an agent on it.

```bash
vst worktree create my-app \
  --branch=feat/my-feature \
  --mode=<mode-id> \
  --prompt="Implement the user authentication flow described in docs/auth.md"
```

The `--prompt` is the initial task handed to the agent. The `--mode` ID comes from `vst mode ls`.

### 5. Open the web UI

```bash
vst open my-app
```

This opens your browser to the vibe-station UI where you can watch all agents, browse files, and send follow-up messages.

---

## Core concepts

### Projects

A project is a registered git repository. All worktrees for a project are created inside `~/.vibe-station/projects/<project-id>/worktrees/`.

```bash
vst project ls
vst project info my-app
vst project rm my-app
```

### Worktrees

A worktree is an isolated `git worktree` checkout on its own branch. It's the unit of parallel work — one feature, one bug fix, one experiment. Each worktree is completely independent: agents in different worktrees work on different branches and can never overwrite each other's files.

When you create a worktree, vibe-station automatically creates a **main session** on it and starts your agent. The worktree and its main session are always created together.

```bash
vst worktree ls --project=my-app
vst worktree info <worktree-id>
vst worktree rm <worktree-id>     # removes the branch, worktree, and all its sessions
```

### Sessions (tabs)

A session is a running process inside a worktree — either an **AI agent** or a plain **terminal**. Every worktree starts with one session and you can add more as needed. Think of them as tabs that all share the same branch and file system.

**The main session** (slot `m`) is created automatically with the worktree. It runs your primary agent and cannot be removed — it lives as long as the worktree does.

**Additional sessions** can be agents or terminals, and can be added or removed freely:

```bash
# Add a second agent (e.g. to write tests while the main agent writes code)
vst session create <worktree-id> --type=agent --mode=<mode-id> --prompt="Write tests for the auth module"

# Add a plain terminal — no AI, just a shell in the worktree
vst session create <worktree-id> --type=terminal
```

Session slots are named `m` (main agent), `a2`, `a3` (extra agents), `t1`, `t2` (terminals).

```bash
vst session ls --worktree=<worktree-id>
vst session info <session-id>
vst session kill <session-id>       # any session except the main slot
vst session attach <session-id>     # drop into the raw tmux session
```

> **Worktree vs session in short:** a worktree is the isolated branch + directory; sessions are the processes running inside it. One worktree, many sessions.

### Modes

Modes define how agents are configured. Each mode binds an AI CLI to an optional context string that gets prepended to every agent's system prompt.

```bash
vst mode ls
vst mode add --name="Reviewer" --cli=claude --context="You review code for correctness and clarity."
vst mode rm <mode-id>              # blocked if sessions are using it
```

You can have up to 10 modes.

---

## Sending messages to agents

Once a session is running, send it a follow-up message:

```bash
# Inline message
vst send <session-id> "Add error handling for the network timeout case"

# From a file
vst send <session-id> --file=./instructions.md

# Wait for the agent to go idle before returning
vst send <session-id> "Refactor the data layer" --wait
```

---

## Monitoring agents

Stream an agent's output to your terminal:

```bash
# Show last 100 lines
vst session output <session-id> --lines=100

# Follow live (like tail -f)
vst session output <session-id> --follow
```

Check overall status across all your projects:

```bash
vst status
vst status --project=my-app --json
```

---

## Session lifecycle

Sessions move through these states:

| State | Meaning |
|---|---|
| `not_started` | Spawned but not yet launched |
| `working` | Agent is actively processing |
| `idle` | Agent is waiting for input |
| `done` | Agent has completed its task |
| `exited` | tmux session died (can be resumed) |

### Resuming exited sessions

If the daemon restarts or tmux dies, sessions can be restored:

```bash
vst session restore <session-id>
```

Claude Code sessions resume with full conversation history. Cursor sessions restart fresh (API limitation). OpenCode sessions resume if a session ID was captured.

---

## Web UI overview

The UI is organized around a **workspace** layout:

- **Left sidebar** — project and worktree navigator; create/delete worktrees here
- **Terminal panel** — live streaming output for the selected session; send messages inline
- **File tree** — browse files in the active worktree
- **Preview panel** — render files (markdown, diagrams, code), view diffs

Tabs at the top of the terminal panel correspond to sessions (`m`, `a2`, `t1`, etc.). Click to switch between them or use the `+` button to add new sessions.

To view a diff of changes an agent made:

1. Select a file in the file tree
2. Click the **Diff** toggle in the preview panel
3. Choose `local` (working tree vs HEAD) or `branch` (vs base branch)

---

## Project-specific agent rules

Drop an `AGENTS.md` file in your project root (or `.vibe-station/rules.md`) to inject project-specific instructions into every agent spawned for that project:

```markdown
# AGENTS.md

- Always write tests for new functions
- Use the existing logger from src/lib/logger.ts
- Never modify migration files directly
```

vibe-station reads this file at spawn time and includes it in the agent's system prompt.

---

## Data directory

vibe-station stores all its state in `~/.vibe-station/`:

```
~/.vibe-station/
├── config.json          # daemon port, PID
├── modes.json           # your configured modes
├── logs/
│   └── daemon.log
└── projects/
    └── <project-id>/
        ├── manifest.json    # worktrees + sessions for this project
        └── worktrees/
            └── <worktree-id>/   # git worktree checkout
```

The daemon manages this automatically. You shouldn't need to edit these files manually.

---

## Development

```bash
# Start the dev server (hot reload for the web UI)
pnpm dev        # http://localhost:5173

# Build everything
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

The project is a monorepo with three sibling directories at the root:

- `web-ui/` — React 19 + Vite frontend (`@vibestation/web`)
- `cli/` — `vst` CLI binary (`@vibestation/cli`)
- `daemon/` — Fastify HTTP server + PTY/tmux management (TypeScript source only — compiled into `cli/dist/daemon/` via a source symlink, not a separate package)

`cli/src/daemon` is a symlink to `../../daemon/src`, so a single `tsc` in `cli/` compiles both the CLI commands and the daemon in one pass. The daemon runs as a detached child process spawned by `vst daemon start` — it is not imported as a module.

> **Windows:** Git requires symlink support (`git config core.symlinks true` + Developer Mode enabled) for `cli/src/daemon` to clone correctly. Without it the build will fail. Linux and macOS work out of the box.

> **Editor tip:** Open daemon source via `cli/src/daemon/` (the symlink path) rather than `daemon/src/` directly — TypeScript's project context and `go-to-definition` are anchored to the `cli/` tsconfig, so the symlink path gives you full IDE support.

---

## CLI reference

```
vst project   add | rm | ls | info
vst worktree  create | rm | ls | info
vst session   create | kill | ls | info | attach | restore | output
vst mode      add | rm | ls
vst send      <session-id> [message] [--file] [--wait]
vst status    [--project] [--json]
vst open      [target]
vst daemon    start | stop | restart | status
vst doctor
vst completion <bash|zsh|fish>
```

Run `vst <command> --help` for full options on any subcommand.

---

## Troubleshooting

**`vst doctor`** is your first stop — it checks for tmux, git, and AI CLIs.

**Daemon not starting:**
```bash
vst daemon status
cat ~/.vibe-station/logs/daemon.log
```

**Orphaned worktrees after a crash:**
```bash
vst doctor    # detects and offers to clean up orphans
```

**Port conflict (7421 already in use):**
The daemon auto-picks the next free port. Check `~/.vibe-station/config.json` for the actual port in use.

**Claude sessions not resuming:**
Make sure you're on Claude Code ≥ 1.x with the `--resume` flag available. Run `claude --version` to check.
