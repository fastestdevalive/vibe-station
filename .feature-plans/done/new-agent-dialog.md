# Mini-Design: "New Agent" dialog (was "New Project")

> Rename the New Project dialog → **New Agent**; always start an agent (no toggle);
> make every new/added project git-ready via a bundled `.sh` script; add Branch +
> Base-branch fields when "Use worktree" is on. (Opus-reviewed; adjustments folded in.)

**Branch:** `revisit-projects` (amend the single commit) · **Status:** Ready

---

## Decisions

1. Rename dialog + component `AddProjectDialog` → `NewAgentDialog`; title **"New Agent"**.
2. Remove the "Start an agent" checkbox — an agent is **always** started. Agent config
   (worktree / mode / prompt) always visible. Worktree label = **"Use worktree"**.
3. Every create-new / add-existing dir is made git-ready by a **setup `.sh` script**:
   `git init`, type-aware `.gitignore`, and an initial commit establishing **`main`**
   (so `git worktree add … main` has a ref). Idempotent; no-op on a repo with commits.
4. "Use worktree" reveals **Branch** + **Base branch** (see UI matrix below).

## Backend

`daemon/src/assets/project-setup.sh` (NEW, run via `runProjectSetup(dir)` in
`daemon/src/services/projectSetup.ts` using `execFile("bash",[script,dir])`):

```sh
#!/usr/bin/env bash
set -euo pipefail
dir="$1"; cd "$dir"
[ -d .git ] || git init -q

gitignore() { # $1 = section
  case "$1" in
  os) cat <<'EOF'
# OS / editors / IDEs
.DS_Store
Thumbs.db
.idea/
.vscode/
.fleet/
*.iml
*.swp
EOF
  ;;
  node) cat <<'EOF'

# Node / JS / TS
node_modules/
dist/
build/
coverage/
.next/
.turbo/
.cache/
*.log
.env
.env.*
!.env.example
EOF
  ;;
  gradle) cat <<'EOF'

# Gradle / JVM / Android / KMP
.gradle/
build/
local.properties
!gradle/wrapper/gradle-wrapper.jar
*.apk
*.aab
*.dex
captures/
.cxx/
.kotlin/
kotlin-js-store/
xcuserdata/
DerivedData/
EOF
  ;;
  python) cat <<'EOF'

# Python
__pycache__/
*.py[cod]
.venv/
venv/
*.egg-info/
.pytest_cache/
EOF
  ;;
  rust) printf '\n# Rust\ntarget/\n' ;;
  go)   printf '\n# Go\nbin/\n*.exe\n' ;;
  esac
}

if [ ! -f .gitignore ]; then
  { gitignore os
    det=0
    if ls package.json pnpm-lock.yaml yarn.lock >/dev/null 2>&1; then gitignore node; det=1; fi
    if ls build.gradle build.gradle.kts settings.gradle settings.gradle.kts >/dev/null 2>&1 || [ -d gradle ]; then gitignore gradle; det=1; fi
    if ls pyproject.toml requirements.txt setup.py >/dev/null 2>&1; then gitignore python; det=1; fi
    [ -f Cargo.toml ] && { gitignore rust; det=1; }
    [ -f go.mod ] && { gitignore go; det=1; }
    if [ "$det" -eq 0 ]; then gitignore node; gitignore gradle; fi
  } > .gitignore
fi

# Establish `main` with an initial commit so worktrees can branch off it. The
# HEAD guard makes this a no-op for any repo that already has commits — so an
# existing `master` repo is never renamed. Stages only .gitignore, not user files.
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git config user.email >/dev/null 2>&1 || git config user.email "agent@vibe-station.local"
  git config user.name  >/dev/null 2>&1 || git config user.name  "vibe-station"
  [ -f .gitignore ] && git add .gitignore
  git commit -q --allow-empty -m "Initial commit"
  git branch -M main
fi
```

- **`POST /projects/create`** — swap inline `gitInit`/`createGitignore` for `runProjectSetup`.
  Extend `startAgent` with **`branch`** only (base is always `main` here — setup guarantees it;
  drop a redundant `baseBranch`). Replace the hardcoded `branch="feature"` with the supplied
  branch; validate via `validateBranch` and reject `branch === "main"` (collides with the checkout).
- **`POST /projects`** (add existing) — accept `setup?: boolean`. When true: register, run
  `runProjectSetup(dir)`, then **re-run `detectDefaultBranch` and set `isGit=true` + `defaultBranch`
  on the record** before returning (so the client gets the real base). Setup failure → return the
  registered project with a `warning` (never delete the user's dir).
- `runProjectSetup` falls back to existing `gitInit`/`createGitignore` if `bash` is unavailable.

## Frontend (`NewAgentDialog`)

- Rename file/component/import. Remove `startAgent` state + checkbox + all its branches.
- **Base/branch matrix** (fields gated on `useWorktree && !worktreeDisabled`):

  | Source | Branch | Base branch |
  |--------|--------|-------------|
  | create-new | text (default `feature`) | fixed `main` (note "main will be initialized") |
  | add-existing-path | text (default `feature`) | note "repository default (main if new)" — resolved server-side from returned `defaultBranch` |
  | use-existing (git) | text | `<select>` from `GET /projects/:id/branches` (default = detected), with loading + **free-text fallback on fetch error** (reuse `NewSessionDialog` pattern) |
  | use-existing (non-git) | — | worktree disabled + note (already implemented) |

- Client-side branch guard when worktree checked: required, valid ref, not `main`.
- **Submit** (dialog owns spawn + navigation):
  - create-new → `POST /projects/create {startAgent:{modeId,prompt,useWorktree,branch}}` → navigate to returned session/worktree.
  - add-path → `POST /projects {path,setup:true}` → direct: `createDirectSession`; worktree: `POST /worktrees {projectId,branch,baseBranch:returned defaultBranch,modeId,prompt}` → navigate.
  - use-existing → direct: `createDirectSession`; worktree: `POST /worktrees {…,baseBranch:selected}` → navigate.
- **`LeftSidebar.onCreated` → no-op/refresh** (dialog now owns spawning) to avoid double-spawn.
- Mock: `createProject` honors `startAgent` (returns session, emits `session:created`) so mock UI navigates.

## Files

| File | Change |
|------|--------|
| `daemon/src/assets/project-setup.sh` | NEW — git init + type-aware .gitignore + `main` base commit |
| `daemon/src/services/projectSetup.ts` | NEW — `runProjectSetup(dir)` (+bash-missing fallback) |
| `daemon/src/routes/projects.ts` | create: use script, `branch` param + validate; add: `setup?`, re-detect defaultBranch |
| `daemon/src/routes/worktrees.ts` | (verify base-branch contract; no change expected) |
| `web-ui/src/api/{types,client,mock}.ts` | `startAgent.branch`; `AddProjectBody.setup`; mock startAgent |
| `web-ui/src/components/dialogs/NewAgentDialog.tsx` | rename; drop startAgent; branch/base UI; submit routing |
| `web-ui/src/components/layout/LeftSidebar.tsx` | rename/import + copy; `onCreated` → no-op |

## Phases

1. **Backend** — setup.sh + `runProjectSetup`; wire into create (branch+validate) & add (`setup`, re-detect). Verify: `pnpm --filter @vibestation/cli typecheck`; curl create-new+worktree succeeds; add non-git dir → `isGit`/`defaultBranch` correct.
2. **Frontend** — rename, drop toggle, branch/base matrix, submit routing, `onCreated` no-op, mock. Verify: `npx tsc --noEmit && npx vitest run`; manual all 4 sources × direct/worktree.

## UI reference — see the ASCII states below

### Create-new (worktree off)

```text
┌─ New Agent ───────────────────────────────────────┐
│  Project   [ my-new-app                        ]  │
│  Directory [ ~/projects/                     ▾ ]  │
│  Will create: ~/projects/my-new-app               │
│  ⓘ Sets up git (init + .gitignore) if needed.     │
│  ─ Agent ───────────────────────────────────────  │
│  ☐ Use worktree                                   │
│  Mode   [ Claude — Bugfix            ▾ ]          │
│  Prompt [ What should the agent work on?       ]  │
│                    [ Cancel ]  [ Create & Start ] │
└───────────────────────────────────────────────────┘
```

### Worktree on — branch + base revealed

```text
│  ☑ Use worktree                                   │
│    Branch      [ feature                       ]  │
│    Base branch [ main ]  (main will be initialized)   ← create-new / add-path(new)
│    Base branch [ main            ▾ ]  develop, …      ← use-existing (git repo)
```

### Use existing (chip)

```text
│  Project [ ◧ webapp ✕ ]   Using ~/work/webapp     │
│  ─ Agent ───────────────────────────────────────  │
│  ☑ Use worktree   Branch [ feature ]  Base [ main ▾ ] │
│  Mode [ … ▾ ]   Prompt [ … ]        [ Cancel ] [ Start ] │
```
