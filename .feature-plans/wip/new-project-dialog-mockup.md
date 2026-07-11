# New Project Dialog — ASCII Mockup (design iteration)

> No tabs. One smart "Project" field: type a new name (free text) OR pick an
> existing project (becomes a chip). This doc is ASCII-only for fast iteration
> before we touch code.

---

## Core behavior

- **Single combobox field.** No "Create new / Add existing" tabs.
- As you type, a popup opens with **two sections**:
  1. **Create new** — always the first row; reflects what you typed.
  2. **Use existing** — all existing projects, filtered by the typed text.
- **Select existing** → the field collapses into a **chip** (`name ✕`). Cross removes it, returning to free text.
- **Free-text (create new)** → field stays plain text; the "Directory" row + git-init FYI appear.
- **Directory field** (create-new only) is itself a combobox: typing shows **path suggestions**.
- Agent section: checkbox relabeled **"Start an agent"** (was "Start an agent after creating").
- Worktree toggle shows an **FYI: this runs `git init` in the project directory**.

---

## State A — field focused, empty

```
┌─ New Project ─────────────────────────────────────┐
│                                                   │
│  Project                                          │
│  ┌─────────────────────────────────────────────┐ │
│  │ Search projects or type a new name…       ▾ │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ ✦  Create new project                       │ │ ← always first
│  │    Start typing a name…                     │ │
│  ├─────────────────────────────────────────────┤ │
│  │  USE EXISTING                               │ │
│  │  ▸ proj-a          ~/code/proj-a            │ │
│  │  ▸ proj-b          ~/code/proj-b            │ │
│  │  ▸ webapp          ~/work/webapp            │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│                              [ Cancel ]  [ Add ]  │
└───────────────────────────────────────────────────┘
        (primary button disabled until a choice is made)
```

---

## State B — typing "we" (free text) → filtered

```
│  Project                                          │
│  ┌─────────────────────────────────────────────┐ │
│  │ we|                                       ▾ │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ ✦  Create new project  “we”         ⏎       │ │ ← highlighted
│  │    Creates ~/projects/we                    │ │
│  ├─────────────────────────────────────────────┤ │
│  │  USE EXISTING (1)                           │ │
│  │  ▸ webapp          ~/work/webapp            │ │
│  └─────────────────────────────────────────────┘ │
```

- Enter on "Create new" → commits free-text name, closes popup, shows Directory row (State D).
- Click an existing row → State C.

---

## State B2 — typing an absolute path → "Add existing directory" row

```
│  Project                                          │
│  ┌─────────────────────────────────────────────┐ │
│  │ ~/work/cloned-repo|                       ▾ │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ ＋  Add existing directory                  │ │ ← only when text is an
│  │    ~/work/cloned-repo                       │ │   absolute path (/… or ~/…)
│  │    …not yet a vibe-station project          │ │   and not already registered
│  └─────────────────────────────────────────────┘ │
```

- Registers an on-disk directory that isn't yet a project (routes to `addProject`).
- Non-path free text never shows this row (only Create-new + existing matches).

---

## State C — existing project selected → chip

```
│  Project                                          │
│  ┌─────────────────────────────────────────────┐ │
│  │ ╭───────────────╮                           │ │
│  │ │ ◧ webapp    ✕ │                           │ │ ← chip; ✕ clears → back to text
│  │ ╰───────────────╯                           │ │
│  └─────────────────────────────────────────────┘ │
│  Using existing project at ~/work/webapp          │
│                                                   │
│  ☐ Start an agent                                 │
│                                                   │
│                              [ Cancel ]  [ Add ]  │
└───────────────────────────────────────────────────┘
```

- No Directory row (it already exists).
- Worktree option (if shown under "Start an agent") has **no** git-init FYI for an
  existing git repo; for a non-git existing dir, worktree is disabled with a note.

---

## State D — create-new committed → Directory + agent

```
┌─ New Project ─────────────────────────────────────┐
│                                                   │
│  Project                                          │
│  ┌─────────────────────────────────────────────┐ │
│  │ my-new-app                                  │ │ ← plain text (no chip)
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  Directory                                        │
│  ┌─────────────────────────────────────────────┐ │
│  │ ~/projects/|                              ▾ │ │  (prefilled from Settings'
│  └─────────────────────────────────────────────┘ │   defaultProjectsDir)
│  ┌─────────────────────────────────────────────┐ │
│  │  ~/projects/                                │ │ ← live fs suggestions
│  │  ~/code/                                    │ │   (as you type)
│  │  ~/work/                                    │ │
│  └─────────────────────────────────────────────┘ │
│  Will create:  ~/projects/my-new-app              │
│  ⓘ New projects are initialized as a git repo     │  ← git init ALWAYS runs in
│    (runs `git init`).                             │    create mode (not gated on
│                                                   │    the worktree checkbox)
│                                                   │
│  ☑ Start an agent                                 │
│  ┌───────────────────────────────────────────┐   │
│  │ ☑ Use worktree isolation                  │   │
│  │   runs the agent on an isolated branch     │   │
│  │   (git repo required — created above)      │   │
│  │                                           │   │
│  │ Mode    [ Claude — Bugfix            ▾ ]  │   │
│  │                                           │   │
│  │ Prompt                                    │   │
│  │ ┌───────────────────────────────────────┐ │   │
│  │ │ What should the agent work on?        │ │   │
│  │ └───────────────────────────────────────┘ │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│                          [ Cancel ]  [ Create ]   │
└───────────────────────────────────────────────────┘
```

- Primary button label: **Create** (create-new) vs **Add** (existing).
- With "Start an agent" on: **Create & Start** / **Add & Start**.
- git-init FYI shows only when **Use worktree isolation** is checked in create-new mode.

---

## Decisions

1. **Directory suggestions = live filesystem autocomplete.** As you type a path,
   the daemon lists real subdirectories to complete against.
   → Needs a new guarded endpoint, e.g. `GET /fs/complete?path=<partial>` returning
     immediate child directories. Guards: resolve `~`, only return dirs, cap count,
     never traverse into unreadable paths, no file contents.
2. **Non-git existing project + worktree = disabled with a note.** The "Use worktree
   isolation" checkbox is greyed out with `not a git repo — direct agent only`.

## Non-git existing project — worktree disabled state

```
│  ☑ Start an agent                                 │
│  ┌───────────────────────────────────────────┐   │
│  │ ☐ Use worktree isolation   (disabled)     │   │
│  │   not a git repo — direct agent only      │   │
│  │ Mode    [ Claude — Bugfix            ▾ ]  │   │
│  └───────────────────────────────────────────┘   │
```

## Still-open (minor — proposed defaults)

- **Chip removal (✕)** → resets field to **empty** (proposed). Alt: restore prior text.
- **Keyboard** → ↑/↓ moves across Create-new + existing rows, Enter picks, Esc closes
  the popup (not the dialog). Proposed as default.
```
