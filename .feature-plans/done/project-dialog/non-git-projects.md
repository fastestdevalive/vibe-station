# Mini-Design: Non-Git Project Support

> Allow any directory as a project; worktrees require git; direct agent spawn for non-git.

**Branch:** `revisit-projects`
**Status:** Pending

**Reference files:**
- Schema: `daemon/src/types.ts:16,64-77` (SessionSlot, ProjectRecord)
- Project routes: `daemon/src/routes/projects.ts`
- Worktree routes: `daemon/src/routes/worktrees.ts`
- Git service: `daemon/src/services/git.ts`
- Session routes: `daemon/src/routes/sessions.ts:18-26,33-53,125-140` (CreateSessionBody, findSessionContext, serializeSession)
- Session ID: `daemon/src/services/sessionId.ts:71-73` (buildTmuxName)
- Manifest: `daemon/src/services/manifest.ts:11-19`
- Paths: `daemon/src/services/paths.ts` (sessionDataDir)
- Recovery: `daemon/src/services/recover.ts:10-72`
- Prompt builder: `daemon/src/services/promptBuilder.ts:78`
- UI Dialog: `web-ui/src/components/dialogs/NewSessionDialog.tsx`
- Sidebar: `web-ui/src/components/layout/LeftSidebar.tsx`
- API types: `web-ui/src/api/types.ts:42` (Session.worktreeId)

---

## Problem

- Only git repos can be added as projects today
- Users cannot work on non-git directories (scripts, notes, experiments)
- No UI for adding projects — must use CLI

## Out of Scope

- Converting non-git project to git project in-app
- Multi-root workspaces
- `defaultProjectsDirectory` global setting (defer to v2)

## Concept

- Any directory → valid project
- Git projects → worktrees OR direct agents
- Non-git projects → direct agents only (no worktree option)
- "+ Project" button in sidebar opens simple path input dialog

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Flow                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   [+ Project]  ─────────────────────────────────────────────┐   │
│        │                                                    │   │
│        ▼                                                    │   │
│   ┌─────────────┐    ┌────────────────────────────────────┐ │   │
│   │ Enter Path  │───►│ POST /projects                     │ │   │
│   │ (text input)│    │   → validates: exists, is dir,     │ │   │
│   └─────────────┘    │     absolute, not duplicate        │ │   │
│                      │   → sets isGit: true/false         │ │   │
│                      └────────────────────────────────────┘ │   │
│                                                              │   │
│   [+ on Project] ────────────────────────────────────────────┘   │
│        │                                                         │
│        ▼                                                         │
│   ┌─────────────────────────────────────────────────────┐        │
│   │ isGit?                                              │        │
│   │  ├─ YES → Show: [+ Worktree] [+ Direct Agent]       │        │
│   │  └─ NO  → Show: [+ Agent] (direct in project dir)   │        │
│   └─────────────────────────────────────────────────────┘        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Model Changes

| Entity | Field | Type | Change |
|--------|-------|------|--------|
| `SessionSlot` | — | union | **ADD** `\| \`d${number}\`` for direct slots |
| `ProjectRecord` | `isGit` | `boolean` | **NEW** — true if git repo |
| `ProjectRecord` | `defaultBranch` | `string \| undefined` | Make optional (git only) |
| `ProjectRecord` | `directSessions` | `SessionRecord[]` | **NEW** — sessions without worktree |
| `ProjectRecord` | `directSessionSeq` | `number \| undefined` | **NEW** — monotonic counter for d-slots |
| `Session` (UI) | `worktreeId` | `string \| null` | **CHANGE** — null for direct sessions |
| `Session` (UI) | `projectId` | `string` | **NEW** — always present |

### Session Hierarchy (Before vs After)

```
BEFORE:                          AFTER:
ProjectRecord                    ProjectRecord
  └─ worktrees[]                   ├─ isGit: boolean
       └─ sessions[]               ├─ directSessions[]  ← NEW
                                   ├─ directSessionSeq  ← NEW
                                   └─ worktrees[]
                                        └─ sessions[]
```

---

## API Changes

### Modified Endpoints

```
POST /projects
  Before: Requires git repo, returns 400 if not
  After:  Accepts any directory
    - Validates: path exists, is directory, is absolute, not already registered
    - Sets isGit based on git check (no error if false)
    - defaultBranch only set if isGit
  Response: { ...project, isGit: boolean }

GET /projects/:id/branches
  Before: Returns 400 if not git
  After:  Returns { branches: [] } if !isGit (no error)

POST /worktrees
  Change: Returns 400 "Worktrees require a git repository" if !project.isGit

POST /sessions
  Before: { worktreeId, type, modeId?, ... }
  After:  Discriminated union via `target` field:
    - { target: "worktree", worktreeId, type, modeId?, ... } — existing behavior
    - { target: "direct", projectId, type, modeId?, ... } — direct session
  Backward compat: If no `target` field, infer from presence of worktreeId

GET /sessions
  After: Include directSessions in flat list
  Response shape: { ..., worktreeId: string | null, projectId: string }

DELETE /sessions/:id
  After: Handle directSessions cleanup (search both worktree.sessions[] and project.directSessions[])
```

---

## UI Changes Summary

| Component | Change |
|-----------|--------|
| `LeftSidebar.tsx` | Add "+ Project" button; render directSessions under project |
| `NewSessionDialog.tsx` | For non-git: hide worktree radio, show direct agent form |
| `NewSessionDialog.tsx` | For git: show worktree vs direct agent choice |
| New: `AddProjectDialog.tsx` | Path text input + validation feedback |
| `web-ui/src/api/types.ts` | Update Session type with nullable worktreeId, required projectId |

---

## Key Decisions

### D1: `isGit` boolean vs project `type` enum

- **Decision:** Boolean `isGit` flag
- **Rationale:** Only two cases; enum overkill

### D2: Reuse `POST /sessions` vs new endpoint

- **Decision:** Extend `POST /sessions` with discriminated union
- **Rationale:** Reuses spawn/lifecycle; keeps session API unified

### D3: Session context lookup

- **Decision:** Discriminated return type from `findSessionContext`:
  ```ts
  | { kind: "worktree"; project; worktree; session }
  | { kind: "direct"; project; session }
  ```
- **Rationale:** TypeScript enforces correct handling at each call site

### D4: Slot allocation for direct sessions

- **Decision:** Extend `SessionSlot` with `d${number}` prefix
- **Rationale:** Clean separation from worktree slots (`m`, `a1`, `t1`)

### D5: tmux name for direct sessions

- **Decision:** Format `vr-{prefix}-d{N}` (no worktree segment)
- **Rationale:** Direct sessions have no worktree number

### D6: Direct session data dir

- **Decision:** `{VST_DATA_DIR}/projects/{projectId}/sessions/{sessionId}/`
- **Rationale:** No worktree level; keeps paths clean

### D7: Allow direct sessions for git projects

- **Decision:** Yes, allow in v1
- **Rationale:** Restricting to `!isGit` adds complexity without clear benefit; users may want quick sessions without branch isolation

---

## Implementation Phases

### Phase 0 — Migration / Backfill

| # | Task | File |
|---|------|------|
| 0.1 | In `readManifest`, backfill missing `isGit: true` | `daemon/src/services/manifest.ts:11-19` |
| 0.2 | In `readManifest`, backfill missing `directSessions: []` | `daemon/src/services/manifest.ts` |
| 0.3 | Update test fixtures with `isGit`, `directSessions` | `daemon/src/**/*.test.ts` |

**Verify:**
- [ ] 0.T1 — Existing manifests load without error
- [ ] 0.T2 — All tests pass with new required fields

---

### Phase 1 — Data Model

| # | Task | File |
|---|------|------|
| 1.1 | Extend `SessionSlot` type: add `\| \`d${number}\`` | `daemon/src/types.ts:16` |
| 1.2 | Add `isGit: boolean` to `ProjectRecord` | `daemon/src/types.ts:64-77` |
| 1.3 | Make `defaultBranch` optional: `defaultBranch?: string` | `daemon/src/types.ts` |
| 1.4 | Add `directSessions: SessionRecord[]` to `ProjectRecord` | `daemon/src/types.ts` |
| 1.5 | Add `directSessionSeq?: number` to `ProjectRecord` | `daemon/src/types.ts` |
| 1.6 | Audit `defaultBranch` usages, add guards | grep callsites |
| 1.7 | Guard in `promptBuilder.ts:78` for non-git | `daemon/src/services/promptBuilder.ts` |

**Verify:**
- [ ] 1.T1 — TypeScript compiles with optional `defaultBranch`
- [ ] 1.T2 — `tsc --noEmit` passes

---

### Phase 2 — Project Routes (Accept Non-Git)

| # | Task | File |
|---|------|------|
| 2.1 | Replace git check with `isGit` flag assignment | `daemon/src/routes/projects.ts:92-96` |
| 2.2 | Add path validations (exists, isDir, absolute, unique) | `daemon/src/routes/projects.ts` |
| 2.3 | Skip `detectDefaultBranch` if `!isGit` | `daemon/src/routes/projects.ts:103-107` |
| 2.4 | Return empty branches array if `!isGit` | `daemon/src/routes/projects.ts:71-77` |
| 2.5 | Add `isGit` to project response serialization | `daemon/src/routes/projects.ts` |

**Verify:**
- [ ] 2.T1 — `POST /projects` with non-git dir → 201, `isGit: false`
- [ ] 2.T2 — `POST /projects` with git dir → 201, `isGit: true`, `defaultBranch` set
- [ ] 2.T3 — `POST /projects` with invalid path → 400 with clear error
- [ ] 2.T4 — `GET /projects/:id/branches` for non-git → `{ branches: [] }`

---

### Phase 3 — Worktree Guard

| # | Task | File |
|---|------|------|
| 3.1 | Load project, check `isGit` before worktree create | `daemon/src/routes/worktrees.ts` |
| 3.2 | Return 400 "Worktrees require a git repository" | `daemon/src/routes/worktrees.ts` |

**Verify:**
- [ ] 3.T1 — `POST /worktrees` for non-git project → 400

---

### Phase 4 — Session Routes Refactor

| # | Task | File |
|---|------|------|
| 4.1 | Refactor `findSessionContext` to return discriminated union | `daemon/src/routes/sessions.ts:33-43` |
| 4.2 | Add `findDirectSessionContext(projectId, sessionId)` helper | `daemon/src/routes/sessions.ts` |
| 4.3 | Update `serializeSession` to accept optional `worktreeId` | `daemon/src/routes/sessions.ts:125-140` |
| 4.4 | Add `projectId` to serialized session response | `daemon/src/routes/sessions.ts` |
| 4.5 | Update `CreateSessionBody` Zod schema with discriminated union | `daemon/src/routes/sessions.ts:18-26` |
| 4.6 | Add backward compat: infer `target` from `worktreeId` presence | `daemon/src/routes/sessions.ts` |
| 4.7 | Handle `target: "direct"` in POST /sessions | `daemon/src/routes/sessions.ts` |
| 4.8 | Update GET /sessions to include directSessions | `daemon/src/routes/sessions.ts` |
| 4.9 | Update DELETE /sessions to handle direct sessions | `daemon/src/routes/sessions.ts` |
| 4.10 | Update POST /sessions/:id/resume for direct sessions | `daemon/src/routes/sessions.ts:368-512` |
| 4.11 | Update POST /sessions/:id/input for direct sessions | `daemon/src/routes/sessions.ts` |
| 4.12 | Update GET /sessions/:id/output for direct sessions | `daemon/src/routes/sessions.ts` |

**Verify:**
- [ ] 4.T1 — `POST /sessions` with `projectId` → direct session created
- [ ] 4.T2 — `GET /sessions` includes direct sessions with `worktreeId: null`
- [ ] 4.T3 — `DELETE /sessions/:id` works for direct sessions
- [ ] 4.T4 — Resume works for direct sessions

---

### Phase 5 — Session ID + Paths

| # | Task | File |
|---|------|------|
| 5.1 | Add `reserveNextDirectSlot(project)` function | `daemon/src/services/sessionId.ts` |
| 5.2 | Update `buildTmuxName` for direct sessions: `vr-{prefix}-d{N}` | `daemon/src/services/sessionId.ts:71-73` |
| 5.3 | Add `directSessionDataDir(projectId, sessionId)` | `daemon/src/services/paths.ts` |
| 5.4 | Update `cleanupSessionDataDir` to handle direct sessions | `daemon/src/services/paths.ts` |

**Verify:**
- [ ] 5.T1 — Direct slots allocated as `d1`, `d2`, etc.
- [ ] 5.T2 — tmux name for direct session is `vr-{prefix}-d{N}`
- [ ] 5.T3 — Data dir is `~/.vibe-station/projects/{id}/sessions/{sessionId}/`

---

### Phase 6 — Spawn + Recovery

| # | Task | File |
|---|------|------|
| 6.1 | Update spawn to use `project.absolutePath` for direct sessions | `daemon/src/services/spawn.ts` |
| 6.2 | Pass `projectId` instead of `worktreeId` to DirectPtyBackend | `daemon/src/services/spawn.ts` |
| 6.3 | Update `recoverNotStartedSessions` to scan directSessions | `daemon/src/services/recover.ts:10-72` |
| 6.4 | Store session in `project.directSessions[]` via `mutateProject` | `daemon/src/routes/sessions.ts` |

**Verify:**
- [ ] 6.T1 — Agent CWD is `project.absolutePath`
- [ ] 6.T2 — Daemon restart recovers directSessions

---

### Phase 7 — CLI Updates

| # | Task | File |
|---|------|------|
| 7.1 | `vst project add` succeeds for non-git | `cli/src/commands/project/add.ts` |
| 7.2 | Add `--project` flag to `vst session create` | `cli/src/commands/session/create.ts` |
| 7.3 | `vst worktree create` on non-git → clear error | `cli/src/commands/worktree/create.ts` |
| 7.4 | Update `vst session ls` to show direct sessions | `cli/src/commands/session/ls.ts` |

**Verify:**
- [ ] 7.T1 — `vst project add /tmp/non-git` succeeds
- [ ] 7.T2 — `vst session create --project=foo` creates direct session
- [ ] 7.T3 — `vst worktree create` on non-git → error message

---

### Phase 8 — UI: Types + API

| # | Task | File |
|---|------|------|
| 8.1 | Update `Session` type: `worktreeId: string \| null` | `web-ui/src/api/types.ts:42` |
| 8.2 | Add `projectId: string` to `Session` type | `web-ui/src/api/types.ts` |
| 8.3 | Add `isGit: boolean` to `Project` type | `web-ui/src/api/types.ts` |
| 8.4 | Add `directSessions` to `Project` type | `web-ui/src/api/types.ts` |
| 8.5 | Add `addProject(path)` to API client | `web-ui/src/api/client.ts` |
| 8.6 | Update `createSession` to accept `projectId` param | `web-ui/src/api/client.ts` |

**Verify:**
- [ ] 8.T1 — TypeScript compiles with updated types
- [ ] 8.T2 — API client methods work

---

### Phase 9 — UI: Add Project Dialog

| # | Task | File |
|---|------|------|
| 9.1 | Create `AddProjectDialog` with path text input | `web-ui/src/components/dialogs/AddProjectDialog.tsx` |
| 9.2 | Add validation feedback (exists, not duplicate) | `AddProjectDialog.tsx` |
| 9.3 | Add "+ Project" button to sidebar header | `web-ui/src/components/layout/LeftSidebar.tsx` |
| 9.4 | Wire dialog open/close state | `LeftSidebar.tsx` |

**Verify:**
- [ ] 9.T1 — "+ Project" opens dialog
- [ ] 9.T2 — Valid path → project added, dialog closes
- [ ] 9.T3 — Invalid path → inline error message

---

### Phase 10 — UI: Session Dialog + Sidebar

| # | Task | File |
|---|------|------|
| 10.1 | Pass `isGit` to NewSessionDialog | `LeftSidebar.tsx` |
| 10.2 | For git: show worktree vs direct agent toggle | `NewSessionDialog.tsx` |
| 10.3 | For non-git: hide worktree form, show direct agent only | `NewSessionDialog.tsx` |
| 10.4 | Skip branches fetch for non-git | `NewSessionDialog.tsx` |
| 10.5 | Call `POST /sessions` with `projectId` for direct | `NewSessionDialog.tsx` |
| 10.6 | Render directSessions under project in sidebar | `LeftSidebar.tsx` |
| 10.7 | Add concurrent-session warning | `NewSessionDialog.tsx` |

**Verify:**
- [ ] 10.T1 — Git project "+" → shows worktree + direct options
- [ ] 10.T2 — Non-git project "+" → shows direct agent only
- [ ] 10.T3 — Direct sessions visible in sidebar under project

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/types.ts` | 1 | Extend SessionSlot, add isGit, optional defaultBranch, directSessions[], directSessionSeq |
| `daemon/src/services/manifest.ts` | 0 | Backfill isGit, directSessions |
| `daemon/src/routes/projects.ts` | 2 | Remove git check, add validations, add isGit to response |
| `daemon/src/routes/worktrees.ts` | 3 | Guard non-git |
| `daemon/src/routes/sessions.ts` | 4 | Discriminated union, handle direct sessions everywhere |
| `daemon/src/services/sessionId.ts` | 5 | reserveNextDirectSlot, buildTmuxName for direct |
| `daemon/src/services/paths.ts` | 5 | directSessionDataDir |
| `daemon/src/services/spawn.ts` | 6 | Use project.absolutePath for direct |
| `daemon/src/services/recover.ts` | 6 | Scan directSessions |
| `daemon/src/services/promptBuilder.ts` | 1 | Guard defaultBranch usage |
| `cli/src/commands/project/add.ts` | 7 | Works for non-git |
| `cli/src/commands/session/create.ts` | 7 | --project flag |
| `cli/src/commands/session/ls.ts` | 7 | Show direct sessions |
| `cli/src/commands/worktree/create.ts` | 7 | Error for non-git |
| `web-ui/src/api/types.ts` | 8 | Update Session, Project types |
| `web-ui/src/api/client.ts` | 8 | addProject, update createSession |
| `web-ui/src/components/dialogs/AddProjectDialog.tsx` | 9 | New |
| `web-ui/src/components/layout/LeftSidebar.tsx` | 9, 10 | + Project button, directSessions render |
| `web-ui/src/components/dialogs/NewSessionDialog.tsx` | 10 | Git vs non-git branch |

---

## Risks / Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | **Concurrent direct sessions in same dir?** | Show warning in dialog; allow but warn |
| 2 | **Directory picker on web?** | Text input only (no native picker) |
| 3 | **Migration for existing projects?** | Backfill `isGit: true`, `directSessions: []` in `readManifest()` |
| 4 | **worktreePath usage audit** | 15+ call sites; use `project.absolutePath` for direct sessions |
| 5 | **Test fixture updates** | Multiple files hardcode `defaultBranch: "main"` |
