# Mini-Design: New Project Creation Flow

> Enable creating brand-new projects from scratch with git-init, optional agent start, default projects directory, CLI/skill support.

**Issue:** non-git-projects (enhancement)
**Branch:** `revisit-projects`
**Status:** Pending
**Parent design:** `.feature-plans/wip/non-git-projects.md`

**Reference files:**
- Daemon routes: `daemon/src/routes/projects.ts:83-180`
- Daemon paths: `daemon/src/services/paths.ts`
- Daemon main: `daemon/src/main.ts` (config.json handling)
- CLI project add: `cli/src/commands/project/add.ts`
- UI dialog: `web-ui/src/components/dialogs/AddProjectDialog.tsx`
- UI settings: `web-ui/src/components/settings/SettingsPanel.tsx`

---

## Problem

- Current "New Project" only accepts existing directories
- No way to create a brand new project directory with git-init
- No default projects directory setting
- User must manually create directory, git init, then add to vibe-station
- Cannot jump-start new work from UI/CLI with agent ready to go

## Out of Scope

- Project templates (scaffolding React/Node/Python etc.)
- Remote git clone (create from GitHub URL)

## Concept

- Two project creation modes:
  1. **Add existing** — current behavior, point to existing directory
  2. **Create new** — create directory, git init, .gitignore, optionally start agent
- Default projects directory (e.g., `~/projects`) stored in daemon config
- User configures default in Settings panel
- CLI: `vst project create <name>` vs `vst project add <path>`
- After creation, optionally start agent (with/without worktree) + mode + prompt

---

## Architecture

```
User (UI/CLI/Skill)
       ↓
  POST /projects/create  ← NEW endpoint
       ↓
  daemon creates:
    - mkdir <parentDir>/<name>
    - git init
    - .gitignore (standard)
    - registers project
       ↓
  (optional) create worktree + session OR direct session
       ↓
  returns { project, worktree?, session? }
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — Create new project from UI

```
User clicks "+" next to Projects heading
  → Opens "New Project" dialog
  → Selects "Create new" tab (vs "Add existing")
  → Enters project name
  → Sees preview: ~/projects/my-project
  → Optionally checks "Start agent"
  → Selects mode, enters intro prompt
  → Clicks "Create"
  → Daemon creates directory, git init, registers
  → (Optional) Creates worktree + agent session OR direct session
  → UI navigates to new project/session
```

#### CUJ 2 — Create new project from CLI

```
$ vst project create my-app
  → Creates ~/projects/my-app (defaultProjectsDir/name)
  → git init, .gitignore
  → Registers project
  → Outputs: Created project 'my-app' at ~/projects/my-app

$ vst project create my-app --dir ~/code
  → Creates ~/code/my-app (custom parent dir)

$ vst project create my-app --start-agent --mode=claude-default --prompt="Build a React app"
  → Same as above + creates direct agent session
  → Outputs session ID for piping
```

#### CUJ 3 — Configure default projects directory

```
User opens Settings → Projects section
  → Sees "Default projects directory: ~/projects"
  → Clicks edit icon
  → Enters new path
  → Saves → config persisted to ~/.vibe-station/config.json
```

### Data Model

**Config fields in `~/.vibe-station/config.json`:**
```json
{
  "pid": 12345,
  "port": 7421,
  "token": "...",
  "defaultProjectsDir": "/home/user/projects"
}
```

**Config merge behavior:** New config service reads existing config.json, merges in new fields, preserves pid/port/token written by main.ts.

**Default .gitignore:**
```
.DS_Store
node_modules/
.env
.env.local
*.log
```

**New API endpoints:**
```
POST /projects/create
  Request:  { 
    name: string,           // required, validated
    dir?: string,           // parent directory override (default: defaultProjectsDir)
    startAgent?: { 
      modeId: string, 
      prompt?: string, 
      useWorktree?: boolean  // true = create worktree, false = direct session
    } 
  }
  Response: { project: Project, worktree?: Worktree, session?: Session }
  Errors:   
    400 VALIDATION_ERROR (empty name, invalid chars, git not found)
    409 CONFLICT (directory exists, project ID exists)

GET /settings
  Response: { defaultProjectsDir: string }

PATCH /settings
  Request:  { defaultProjectsDir?: string }
  Response: { ok: true }
```

**Name validation rules:**
- Reject empty/whitespace-only
- Reject names with path separators (`/`, `\`)
- Reject names starting with `.`
- Max length 64 chars

**startAgent behavior:**
- When `useWorktree: true`:
  - Branch name: auto-generate (e.g., `main`)
  - BaseBranch: project's detected default branch
  - Creates worktree + session
- When `useWorktree: false` (default):
  - Creates direct session in project directory

### Key Decisions

#### Decision 1: Separate endpoint `/projects/create` vs extending `/projects`

- **Decision:** New endpoint `POST /projects/create`
- **Rationale:** Clear semantics; `/projects` POST = add existing, `/projects/create` POST = create new
- **Where:** `daemon/src/routes/projects.ts`

#### Decision 2: Separate settings.ts route file

- **Decision:** Create `daemon/src/routes/settings.ts` for GET/PATCH /settings
- **Rationale:** Settings are not project-specific; cleaner separation
- **Where:** New file `daemon/src/routes/settings.ts`

#### Decision 3: Config merge in config.ts

- **Decision:** Config service reads existing, merges, preserves main.ts fields
- **Rationale:** main.ts writes pid/port/token; settings writes defaultProjectsDir
- **Where:** New file `daemon/src/services/config.ts`

#### Decision 4: Git init always (for new projects)

- **Decision:** New projects always get git init
- **Rationale:** Worktrees require git; simplifies v1
- **Where:** `daemon/src/services/git.ts` gitInit() helper

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/services/config.ts` | NEW — read/write/merge config.json |
| `daemon/src/routes/settings.ts` | NEW — GET/PATCH /settings |
| `daemon/src/routes/projects.ts` | Add POST /projects/create |
| `daemon/src/services/git.ts` | Add `gitInit()`, `createGitignore()` |
| `daemon/src/server.ts` | Register settings routes |
| `cli/src/commands/project/create.ts` | NEW — `vst project create` command |
| `cli/src/commands/project/index.ts` | Register create command |
| `web-ui/src/api/client.ts` | Add `createProject()`, `getSettings()`, `updateSettings()` |
| `web-ui/src/api/types.ts` | Add Settings, CreateProjectBody types |
| `web-ui/src/components/dialogs/AddProjectDialog.tsx` | Add "Create new" tab, two-mode UI |
| `web-ui/src/components/settings/SettingsPanel.tsx` | Add default projects dir setting |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Default defaultProjectsDir?** | `~/projects` — created on first project create |
| 2 | **Directory exists handling?** | 409 with "Directory already exists at path" |
| 3 | **Git not found?** | 400 with "git not found in PATH. Install git." |
| 4 | **Permission denied?** | 400 with user-friendly message |

---

## Implementation Phases

### Phase 1 — Daemon: Config + Settings API

- [ ] **1.1** Create `daemon/src/services/config.ts`:
  - `readConfig()` — read existing config.json, return with defaults
  - `writeConfig(partial)` — merge partial into existing, write back
  - Preserve pid/port/token from main.ts
- [ ] **1.2** Create `daemon/src/routes/settings.ts`:
  - `GET /settings` — return { defaultProjectsDir }
  - `PATCH /settings` — update defaultProjectsDir
- [ ] **1.3** Register settings routes in `daemon/src/server.ts`
- [ ] **1.4** Default `defaultProjectsDir` to `~/projects`

**Verify phase 1:**
- [ ] **1.T1** Manual — `curl GET /settings` returns defaultProjectsDir
- [ ] **1.T2** Manual — `PATCH /settings` updates config.json, preserves pid/port

---

### Phase 2 — Daemon: Create Project Endpoint

- [ ] **2.1** Add to `daemon/src/services/git.ts`:
  - `gitInit(dir)` — run `git init` in directory
  - `createGitignore(dir)` — write standard .gitignore
- [ ] **2.2** Add `POST /projects/create` route:
  - Validate name (empty, path separators, leading dot)
  - Resolve full path: `<parentDir>/<name>`
  - Check directory doesn't exist → 409
  - Check project ID not registered → 409
  - mkdir -p
  - gitInit + createGitignore
  - detectDefaultBranch
  - Register project via addProject()
  - If startAgent.useWorktree: create worktree + session
  - If startAgent (no worktree): create direct session
- [ ] **2.3** Return { project, worktree?, session? }

**Verify phase 2:**
- [ ] **2.T1** Manual — `POST /projects/create {name: "test"}` creates dir + git repo
- [ ] **2.T2** Manual — with startAgent, creates session
- [ ] **2.T3** Manual — duplicate name → 409
- [ ] **2.T4** Manual — directory exists → 409

---

### Phase 3 — CLI: project create command

- [ ] **3.1** Create `cli/src/commands/project/create.ts`
- [ ] **3.2** Options: 
  - `--dir <path>` — parent directory override
  - `--start-agent` — start agent after creation
  - `--mode <id>` — mode for agent
  - `--prompt <text>` — intro prompt
  - `--worktree` — use worktree (default: direct session)
- [ ] **3.3** Register in `cli/src/commands/project/index.ts`

**Verify phase 3:**
- [ ] **3.T1** Manual — `vst project create my-app` creates project
- [ ] **3.T2** Manual — `vst project create my-app --start-agent --mode=claude-default` starts agent

---

### Phase 4 — UI: Settings + Dialog

- [ ] **4.1** Add `getSettings()`, `updateSettings()`, `createProject()` to API client
- [ ] **4.2** Add Settings type, CreateProjectBody type to API types
- [ ] **4.3** Add "Default projects directory" section to SettingsPanel
- [ ] **4.4** Refactor AddProjectDialog with tabs: "Create new" | "Add existing"
- [ ] **4.5** "Create new" tab: name input, preview path, start agent options
- [ ] **4.6** On create success, navigate to new project/session

**Verify phase 4:**
- [ ] **4.T1** Manual — Settings shows defaultProjectsDir, can update
- [ ] **4.T2** Manual — New Project dialog has two tabs
- [ ] **4.T3** Manual — Create new project from UI works end-to-end

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/services/config.ts` | 1.1 | NEW — config read/write/merge |
| `daemon/src/routes/settings.ts` | 1.2 | NEW — settings routes |
| `daemon/src/server.ts` | 1.3 | Register settings routes |
| `daemon/src/routes/projects.ts` | 2.2 | Add /projects/create |
| `daemon/src/services/git.ts` | 2.1 | Add gitInit(), createGitignore() |
| `cli/src/commands/project/create.ts` | 3.1-3.2 | NEW — create command |
| `cli/src/commands/project/index.ts` | 3.3 | Register create |
| `web-ui/src/api/client.ts` | 4.1 | Add API methods |
| `web-ui/src/api/types.ts` | 4.2 | Add types |
| `web-ui/src/components/dialogs/AddProjectDialog.tsx` | 4.4-4.5 | Two-tab UI |
| `web-ui/src/components/settings/SettingsPanel.tsx` | 4.3 | Settings UI |
