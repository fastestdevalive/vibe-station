import type {
  AddProjectBody,
  AddProjectResponse,
  Attachment,
  BeginEditResponse,
  ChangedPathEntry,
  Channel,
  CliId,
  CommitLogEntry,
  NormalizedEvent,
  PrInfo,
  CreateDirectSessionBody,
  CreateModeBody,
  CreateProjectBody,
  CreateProjectResponse,
  CreateSessionBody,
  CreateWorktreeBody,
  DiskUsageResponse,
  FileScope,
  FsCheckResponse,
  FsCompleteResponse,
  HealthResponse,
  Mode,
  Project,
  ProjectBranchesResponse,
  SendChatResponse,
  Session,
  SessionMeta,
  Settings,
  SubmoduleInfo,
  SupportedCli,
  TranscriptResponse,
  TranscriptPage,
  TreeEntry,
  UpdateModeBody,
  UploadAttachmentsResponse,
  WSEvent,
  Worktree,
} from "./types";
import { ApiError } from "./errors";

function nowIso() {
  return new Date().toISOString();
}

const PRESET_BUG_FIX =
  "You are fixing a bug. Open a PR when done. Run tests before committing.";
const PRESET_PLANNING = "You are planning. Do not commit or open a PR. Output a written plan.";

/** Fixed home dir + directory tree for the mock `/fs/complete` autocomplete. */
const MOCK_HOME = "/home/user";
const MOCK_FS_TREE: Record<string, string[]> = {
  "/home/user": ["projects", "code", "work"],
  "/home/user/projects": ["proj-a", "proj-b"],
  "/home/user/code": ["webapp"],
  "/home/user/work": ["cloned-repo"],
};

export function createMockApi() {
  /** Daemon-persisted ordered id lists, keyed by scopeKey (pinned-order-sync). */
  const orderedLists = new Map<string, { itemIds: string[]; updatedAt: string }>();

  const projects: Project[] = [
    {
      id: "proj-a",
      name: "Proj A",
      path: "/home/dev/proj-a",
      prefix: "pa",
      isGit: true,
      defaultBranch: "main",
      createdAt: nowIso(),
      hidden: false,
    },
    {
      id: "proj-b",
      name: "Proj B",
      path: "/home/dev/proj-b",
      prefix: "pb",
      isGit: true,
      defaultBranch: "develop",
      createdAt: nowIso(),
      hidden: false,
    },
  ];

  const worktrees: Worktree[] = [
    {
      id: "wt-1",
      projectId: "proj-a",
      branch: "wt-1",
      baseBranch: "main",
      baseSha: "abc123",
      createdAt: nowIso(),
      pinnedAt: null,
      hiddenAt: null,
      sortOrder: 1,
    },
    {
      id: "wt-2",
      projectId: "proj-a",
      branch: "wt-2",
      baseBranch: "main",
      baseSha: "def456",
      createdAt: nowIso(),
      pinnedAt: null,
      hiddenAt: null,
      sortOrder: 2,
    },
    {
      id: "wt-3",
      projectId: "proj-b",
      branch: "wt-main",
      baseBranch: "develop",
      baseSha: "fed789",
      createdAt: nowIso(),
      pinnedAt: null,
      hiddenAt: null,
      sortOrder: 1,
    },
  ];

  const modes: Mode[] = [
    {
      id: "mode-1",
      name: "Bugfix",
      cli: "claude",
      context: PRESET_BUG_FIX,
      presetId: "bug-fix-with-pr",
    },
    {
      id: "mode-2",
      name: "Plan",
      cli: "cursor",
      context: PRESET_PLANNING,
      presetId: "planning-no-pr",
    },
  ];

  const sessions: Session[] = [
    {
      id: "sess-main",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: true,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-main",
      createdAt: nowIso(),
      sortOrder: 1,
    },
    {
      id: "sess-agent2",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-2",
      type: "agent",
      name: "agent-2",
      isMain: false,
      state: "idle",
      lifecycleState: "idle",
      tmuxName: "sess-agent2",
      createdAt: nowIso(),
      sortOrder: 2,
    },
    {
      id: "sess-term1",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: null,
      type: "terminal",
      name: "term-1",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-term1",
      createdAt: nowIso(),
      sortOrder: 3,
    },
    {
      id: "sess-wt2-main",
      worktreeId: "wt-2",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: true,
      state: "done",
      lifecycleState: "done",
      tmuxName: "sess-wt2-main",
      createdAt: nowIso(),
      sortOrder: 1,
    },
    {
      id: "sess-wt3-main",
      worktreeId: "wt-3",
      projectId: "proj-b",
      modeId: "mode-1",
      type: "agent",
      isMain: true,
      state: "idle",
      lifecycleState: "idle",
      tmuxName: "sess-wt3-main",
      createdAt: nowIso(),
      sortOrder: 1,
    },
  ];

  /** Simulated file tree per worktree root path */
  const treeStore: Record<string, Record<string, TreeEntry[]>> = {
    "wt-1": {
      "": [
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file" },
        { name: ".env.local", path: ".env.local", type: "file" },
      ],
      src: [
        { name: "App.tsx", path: "src/App.tsx", type: "file" },
        { name: "main.tsx", path: "src/main.tsx", type: "file" },
        { name: "diagram.md", path: "src/diagram.md", type: "file" },
      ],
    },
    "wt-2": {
      "": [{ name: "index.ts", path: "index.ts", type: "file" }],
    },
    "wt-3": {
      "": [{ name: "pkg", path: "pkg", type: "dir" }],
      pkg: [{ name: "mod.go", path: "pkg/mod.go", type: "file" }],
    },
  };

  const fileContents: Record<string, string> = {
    "README.md": `# Demo\n\n- item one\n- item two\n\n\`\`\`mermaid\ngraph LR\n  A-->B\n\`\`\`\n`,
    "src/App.tsx": `export function App() {\n  return <div>hello</div>;\n}\n`,
    "src/main.tsx": `import { createRoot } from "react-dom/client";\n`,
    "src/diagram.md": `# Flow\n\n\`\`\`mermaid\nflowchart TD\n  Start --> End\n\`\`\`\n`,
    "index.ts": `export const x = 1;\n`,
    "pkg/mod.go": `package pkg\n`,
  };

  const unifiedDiffs: Record<string, string> = {
    "src/App.tsx": `diff --git a/src/App.tsx b/src/App.tsx\nindex 111..222 100644\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n export function App() {\n+  const x = 1;\n   return <div>hello</div>;\n }\n`,
    "README.md": `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Demo\n+added line\n`,
  };

  const listeners = new Map<string, Set<(ev: WSEvent) => void>>();
  const outputTimers = new Map<string, ReturnType<typeof setInterval>>();
  const subscribed = new Set<string>();

  function emit(ev: WSEvent) {
    for (const l of listeners.get("*") ?? []) l(ev);
    for (const l of listeners.get(ev.type) ?? []) l(ev);
  }

  function startOutputSimulation(sessionId: string) {
    if (outputTimers.has(sessionId)) return;
    let n = 0;
    const id = setInterval(() => {
      if (!subscribed.has(sessionId)) return;
      n += 1;
      emit({
        type: "session:output",
        sessionId,
        chunk: `[mock ${sessionId}] line ${n}\r\n`,
      });
      if (n >= 5) {
        clearInterval(id);
        outputTimers.delete(sessionId);
      }
    }, 400);
    outputTimers.set(sessionId, id);
  }

  /** Test hook: force session to exited */
  function simulateExit(sessionId: string) {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.state = "exited";
    s.lifecycleState = "exited";
    emit({ type: "session:exited", sessionId, exitCode: 1 });
    emit({ type: "session:state", sessionId, state: "exited" });
  }

  let daemonDown = false;

  /** In-memory JSON-chat transcripts keyed by sessionId (replayed on openChat). */
  const chatTranscripts = new Map<string, NormalizedEvent[]>();
  let mockTurnSeq = 0;

  const api = {
    __test: {
      simulateExit,
      emit,
      setDaemonDown(v: boolean) {
        daemonDown = v;
      },
      /** Push an event into a mock transcript (for chat:replay in tests). */
      pushChatEvent(sessionId: string, event: NormalizedEvent) {
        const list = chatTranscripts.get(sessionId) ?? [];
        list.push(event);
        chatTranscripts.set(sessionId, list);
      },
    },

    async health(): Promise<HealthResponse> {
      if (daemonDown) {
        throw new ApiError("unreachable", 0);
      }
      return { ok: true, version: "0.0.0-mock", port: 7421 };
    },

    async listProjects(): Promise<Project[]> {
      return structuredClone(projects);
    },

    async addProject(body: AddProjectBody): Promise<AddProjectResponse> {
      const id = body.name ?? body.path.split("/").pop() ?? "new-project";
      const newProject: Project = {
        id,
        name: body.name ?? id,
        path: body.path,
        prefix: id.slice(0, 4),
        isGit: true, // mock assumes git
        defaultBranch: "main",
        createdAt: nowIso(),
        hidden: false,
      };
      projects.push(newProject);
      emit({ type: "project:created", project: structuredClone(newProject) });
      return structuredClone(newProject);
    },

    async deleteProject(_id: string): Promise<{ ok: true }> {
      emit({ type: "project:deleted", projectId: _id });
      return { ok: true };
    },

    async hideProject(id: string): Promise<{ ok: true; project: Project }> {
      const project = projects.find((p) => p.id === id);
      if (!project) throw new ApiError("not found", 404);
      if (!project.hidden) {
        project.hidden = true;
        emit({ type: "project:updated", project: structuredClone(project) });
      }
      return { ok: true, project: structuredClone(project) };
    },

    async unhideProject(id: string): Promise<{ ok: true; project: Project }> {
      const project = projects.find((p) => p.id === id);
      if (!project) throw new ApiError("not found", 404);
      if (project.hidden) {
        project.hidden = false;
        emit({ type: "project:updated", project: structuredClone(project) });
      }
      return { ok: true, project: structuredClone(project) };
    },

    async listWorktrees(projectId?: string): Promise<Worktree[]> {
      return structuredClone(projectId ? worktrees.filter((w) => w.projectId === projectId) : worktrees);
    },

    async listProjectBranches(projectId: string): Promise<ProjectBranchesResponse> {
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new ApiError("not found", 404);
      // Non-git projects return empty branches
      if (!project.isGit) {
        return { branches: [], defaultBranch: "" };
      }
      // Derive a stable branch set: the project default plus any branches its
      // worktrees were based on, deduped with the default listed first.
      const defaultBranch = project.defaultBranch ?? "main";
      const others = worktrees
        .filter((w) => w.projectId === projectId)
        .map((w) => w.baseBranch);
      const branches = [...new Set([defaultBranch, ...others, "feature/example"])].filter(Boolean) as string[];
      return { branches, defaultBranch };
    },

    async createWorktree(body: CreateWorktreeBody): Promise<Worktree> {
      const wtId = `wt-${Date.now()}`;
      const wt: Worktree = {
        id: wtId,
        projectId: body.projectId,
        // Mirrors the daemon's branch-name-optional fallback for a blank
        // branch input (a real slug-from-prompt derivation isn't worth
        // reimplementing in the mock — the placeholder form is enough to
        // exercise the UI path).
        branch: body.branch?.trim() || `wip/${wtId}`,
        baseBranch: body.baseBranch ?? "main",
        baseSha: "mock-base-sha",
        createdAt: nowIso(),
        pinnedAt: null,
        hiddenAt: null,
        mainSessionId: `${wtId}-m`,
      };
      worktrees.push(wt);
      treeStore[wt.id] = {
        "": [],
      };
      emit({ type: "worktree:created", worktree: wt });
      return structuredClone(wt);
    },

    async deleteWorktree(id: string): Promise<{ ok: true }> {
      const idx = worktrees.findIndex((w) => w.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      const wt = worktrees[idx]!;
      const wtSessions = sessions.filter((s) => s.worktreeId === wt.id);
      const notDone = wtSessions.filter((s) =>
        s.type === "agent"
          ? s.state !== "done"
          : s.state !== "done" && s.state !== "exited",
      );
      if (notDone.length > 0) {
        throw new ApiError(
          JSON.stringify({ error: "worktree_not_done", sessions: notDone.map((s) => s.id) }),
          409,
        );
      }
      worktrees.splice(idx, 1);
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i]!.worktreeId === id) sessions.splice(i, 1);
      }
      delete treeStore[id];
      emit({ type: "worktree:deleted", worktreeId: id });
      return { ok: true };
    },

    async getDiskUsage(): Promise<DiskUsageResponse> {
      const TOTAL = 100 * 1024 * 1024 * 1024; // 100 GB
      const USED = 52 * 1024 * 1024 * 1024;   // 52 GB
      return {
        device: {
          totalBytes: TOTAL,
          usedBytes: USED,
          availableBytes: TOTAL - USED,
          mountPoint: "~/.vibe-station",
        },
        worktrees: worktrees.map((wt, i) => ({
          id: wt.id,
          diskBytes: (i + 1) * 400 * 1024 * 1024, // 400 MB, 800 MB, ...
        })),
      };
    },

    async markWorktreeDone(
      id: string,
    ): Promise<{ ok: true; updated: number; terminalsReleased: number }> {
      const wtExists = worktrees.some((w) => w.id === id);
      if (!wtExists) throw new ApiError("not found", 404);
      let updated = 0;
      let terminalsReleased = 0;
      // Mirrors the daemon: agents → done, terminals → exited (their processes
      // are released too, which the mock has no equivalent of).
      for (const s of sessions.filter((x) => x.worktreeId === id)) {
        if (s.type === "agent") {
          if (s.lifecycleState === "done") continue;
          s.state = "done";
          s.lifecycleState = "done";
          emit({ type: "session:state", sessionId: s.id, state: "done" });
          updated += 1;
        } else {
          if (s.lifecycleState === "exited") continue;
          s.state = "exited";
          s.lifecycleState = "exited";
          emit({ type: "session:state", sessionId: s.id, state: "exited" });
          terminalsReleased += 1;
        }
      }
      return { ok: true, updated, terminalsReleased };
    },

    async pinWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      if (wt.pinnedAt == null) {
        wt.pinnedAt = new Date().toISOString();
        emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      }
      return { ok: true, worktree: structuredClone(wt) };
    },

    async unpinWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      if (wt.pinnedAt != null) {
        wt.pinnedAt = null;
        emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      }
      return { ok: true, worktree: structuredClone(wt) };
    },

    async hideWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      if (wt.hiddenAt == null) {
        wt.hiddenAt = new Date().toISOString();
        wt.pinnedAt = null; // hide implies unpin, mirrors the daemon route
        emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      }
      return { ok: true, worktree: structuredClone(wt) };
    },

    async unhideWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      if (wt.hiddenAt != null) {
        wt.hiddenAt = null;
        emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      }
      return { ok: true, worktree: structuredClone(wt) };
    },

    async renameWorktree(id: string, name: string): Promise<{ ok: true; name: string | null }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      const value = name.trim() === "" ? null : name.trim().slice(0, 60);
      wt.name = value;
      emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      return { ok: true, name: value };
    },

    async reorderWorktree(id: string, sortOrder: number): Promise<{ ok: true; sortOrder: number }> {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt) throw new ApiError("not found", 404);
      wt.sortOrder = sortOrder;
      emit({ type: "worktree:updated", worktree: structuredClone(wt) });
      return { ok: true, sortOrder };
    },

    async getOrderedList(scopeKey: string): Promise<{ scopeKey: string; itemIds: string[]; updatedAt: string | null }> {
      const row = orderedLists.get(scopeKey);
      return row
        ? { scopeKey, itemIds: [...row.itemIds], updatedAt: row.updatedAt }
        : { scopeKey, itemIds: [], updatedAt: null };
    },

    async setOrderedList(
      scopeKey: string,
      itemIds: string[],
    ): Promise<{ ok: true; scopeKey: string; itemIds: string[]; updatedAt: string }> {
      const updatedAt = nowIso();
      orderedLists.set(scopeKey, { itemIds: [...itemIds], updatedAt });
      emit({ type: "orderedList:updated", scopeKey, itemIds: [...itemIds], updatedAt });
      return { ok: true, scopeKey, itemIds: [...itemIds], updatedAt };
    },

    async listSessions(worktreeId?: string): Promise<Session[]> {
      return structuredClone(worktreeId ? sessions.filter((s) => s.worktreeId === worktreeId) : sessions);
    },

    async createSession(body: CreateSessionBody): Promise<Session> {
      const wt = worktrees.find((w) => w.id === body.worktreeId);
      const wtSessions = sessions.filter((s) => s.worktreeId === body.worktreeId);
      const nextAgent = wtSessions.filter((s) => s.type === "agent" && !s.isMain).length + 1;
      const nextTerm = wtSessions.filter((s) => s.type === "terminal").length + 1;
      const termName =
        body.type === "terminal"
          ? (body.name?.trim() || `Terminal ${nextTerm}`)
          : undefined;
      const sess: Session = {
        id: `sess-${Date.now()}`,
        worktreeId: body.worktreeId,
        projectId: wt?.projectId ?? "proj-a",
        modeId: body.modeId,
        type: body.type,
        name: termName ?? `agent-${nextAgent}`,
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: `tmux-${Date.now()}`,
        createdAt: nowIso(),
        sortOrder: Date.now(),
      };
      sessions.push(sess);
      emit({
        type: "session:created",
        sessionId: sess.id,
        worktreeId: sess.worktreeId,
        projectId: sess.projectId,
        sessionType: sess.type,
        mode: typeof body.modeId === "string" ? body.modeId : undefined,
        snapshot: sess,
      });
      return structuredClone(sess);
    },

    async createDirectSession(body: CreateDirectSessionBody): Promise<Session> {
      const projSessions = sessions.filter((s) => s.projectId === body.projectId && s.worktreeId === null);
      const nextDirect = projSessions.length + 1;
      const sess: Session = {
        id: `sess-direct-${Date.now()}`,
        worktreeId: null,
        projectId: body.projectId,
        modeId: body.modeId ?? null,
        type: body.type,
        name: body.name ?? (body.type === "terminal" ? `Terminal ${nextDirect}` : `direct ${nextDirect}`),
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: `tmux-direct-${Date.now()}`,
        createdAt: nowIso(),
        sortOrder: Date.now(),
      };
      sessions.push(sess);
      emit({
        type: "session:created",
        sessionId: sess.id,
        worktreeId: null,
        projectId: sess.projectId,
        sessionType: sess.type,
        mode: typeof body.modeId === "string" ? body.modeId : undefined,
        snapshot: sess,
      });
      return structuredClone(sess);
    },

    async nextTerminalName(worktreeId: string): Promise<string> {
      const n = sessions.filter((s) => s.worktreeId === worktreeId && s.type === "terminal").length + 1;
      return `Terminal ${n}`;
    },

    async terminateSession(id: string): Promise<{ ok: true }> {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      const victim = sessions[idx];
      if (!victim) throw new ApiError("not found", 404);
      if (victim.isMain) {
        // Mirrors the daemon's promotion behavior (Fix 1): promote the
        // eligible (type "agent", not archived) sibling with the lowest
        // sortOrder in the same worktree, carrying the old main's `pr`
        // forward, instead of always rejecting.
        const siblings = sessions
          .filter(
            (s) =>
              s.id !== victim.id &&
              s.worktreeId === victim.worktreeId &&
              s.type === "agent" &&
              s.archivedAt == null,
          )
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        const promoted = siblings[0];
        if (!promoted) throw new ApiError("cannot delete main", 400);
        promoted.isMain = true;
        promoted.pr = victim.pr;
        sessions.splice(idx, 1);
        // Unlike the daemon, this mock emits NO event for the delete itself
        // (matches its existing convention — no `emit(...)` call here today).
        // It DOES emit for the promoted sibling's isMain flip: other open
        // surfaces (sidebar rollup, other tabs) have no other way to learn
        // about it in mock/dev mode, since the caller's own refetch only
        // refreshes its own worktree-scoped list, not every mounted component.
        emit({ type: "session:updated", sessionId: promoted.id, isMain: true, pr: promoted.pr ?? undefined });
        return { ok: true };
      }
      sessions.splice(idx, 1);
      return { ok: true };
    },

    async pinSession(id: string, pinned: boolean): Promise<{ ok: true; pinnedAt: string | null }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      s.pinnedAt = pinned ? new Date(0).toISOString() : null;
      return { ok: true, pinnedAt: s.pinnedAt };
    },

    async renameSession(id: string, name: string): Promise<{ ok: true; name: string | null }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      const value = name.trim() === "" ? null : name.trim().slice(0, 60);
      s.name = value;
      s.nameSource = "user";
      emit({ type: "session:updated", sessionId: id, name: value });
      return { ok: true, name: value };
    },

    async reorderSession(id: string, sortOrder: number): Promise<{ ok: true; sortOrder: number }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      s.sortOrder = sortOrder;
      emit({ type: "session:updated", sessionId: id, sortOrder });
      return { ok: true, sortOrder };
    },

    async resetSession(
      id: string,
      body?: { handoff?: boolean; prompt?: string },
    ): Promise<{ ok: true; archivedSessionId: string; newSessionId: string }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      if (s.type !== "agent") throw new ApiError("reset only applies to agent sessions", 400);
      if (s.archivedAt) throw new ApiError("session already archived", 400);

      const archivedAt = nowIso();
      const handoffSummary = body?.handoff ? "Mock handoff summary." : null;
      const newId = `sess-${Date.now()}`; // moved up from below the emit — supersededBy needs this before the emit
      s.archivedAt = archivedAt;
      s.handoffSummary = handoffSummary;
      s.supersededBy = newId;
      emit({ type: "session:updated", sessionId: id, archivedAt, supersededBy: newId });

      const newSession: Session = {
        ...structuredClone(s), // NOTE: this spreads `s`, which now HAS supersededBy: newId set above —
        id: newId,             // the override below is load-bearing, not redundant, or the replacement
        state: "working",      // session ends up superseding ITSELF and gets filtered out by TabsStrip's
        lifecycleState: "working", // new supersededBy != null check, the exact bug this fix is supposed
        tmuxName: `tmux-${Date.now()}`, // to remove, just moved onto the new session.
        createdAt: nowIso(),
        archivedAt: null,
        handoffSummary: null,
        pinnedAt: null,
        supersededBy: null, // MUST override the spread, see NOTE above
      };
      sessions.push(newSession);
      emit({
        type: "session:created",
        sessionId: newId,
        worktreeId: newSession.worktreeId,
        projectId: newSession.projectId,
        sessionType: newSession.type,
        mode: typeof newSession.modeId === "string" ? newSession.modeId : undefined,
        snapshot: newSession,
      });

      return { ok: true, archivedSessionId: id, newSessionId: newId };
    },

    async handoffSession(id: string): Promise<{ ok: true; handoffSummary: string | null }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      if (s.type !== "agent") throw new ApiError("handoff only applies to agent sessions", 400);
      return { ok: true, handoffSummary: "Mock handoff summary." };
    },

    async markSessionDone(id: string): Promise<{ ok: true }> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      if (s.type !== "agent") throw new ApiError("only agent sessions can be marked done", 400);
      s.state = "done";
      s.lifecycleState = "done";
      // Parity with markWorktreeDone (and with the daemon, which broadcasts via
      // persistLifecycleState) — without this the pane never learns it is done
      // and no Resume banner appears.
      emit({ type: "session:state", sessionId: id, state: "done" });
      return { ok: true };
    },

    async resumeSession(id: string): Promise<Session> {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError("not found", 404);
      s.state = "working";
      s.lifecycleState = "working";
      emit({ type: "session:state", sessionId: id, state: "working" });
      emit({ type: "session:resumed", sessionId: id, restoredFromHistory: false });
      if (subscribed.has(id)) {
        startOutputSimulation(id);
      }
      return structuredClone(s);
    },


    async send(message: {
      type: "file:watch" | "file:unwatch" | "tree:watch" | "tree:unwatch" | "ping";
      worktreeId?: string;
      path?: string;
    }): Promise<void> {
      if (message.type === "ping") {
        emit({ type: "pong" });
      }
    },

    async openSession(sessionId: string, _cols?: number, _rows?: number): Promise<void> {
      subscribed.add(sessionId);
      emit({ type: "session:opened", sessionId });
      const s = sessions.find((x) => x.id === sessionId);
      if (s?.state === "working") {
        startOutputSimulation(sessionId);
      }
    },

    async closeSession(sessionId: string): Promise<void> {
      subscribed.delete(sessionId);
    },

    async sendKeystroke(sessionId: string, data: string): Promise<void> {
      setTimeout(() => {
        emit({ type: "session:output", sessionId, chunk: data });
      }, 50);
    },

    async resizeSession(_sessionId: string, _cols: number, _rows: number): Promise<void> {},

    // Diagnostic channel (mobile double-text investigation) — no-op in the mock.
    async sendDebug(): Promise<void> {},

    async getFileBlob(_worktreeId: string, _filePath: string, _scope: FileScope = "worktree"): Promise<Blob> {
      return new Blob([], { type: "image/png" });
    },

    async getFile(worktreeId: string, filePath: string, scope: FileScope = "worktree"): Promise<string> {
      // Project scope (direct sessions) isn't backed by the mock tree store;
      // return a benign placeholder so the preview renders in mock mode.
      if (scope === "project") {
        if (filePath === "HUGE.bin") throw new ApiError("File too large to preview", 422);
        return fileContents[filePath.replace(/^\/+/, "")] ?? `// ${filePath}\n`;
      }
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      if (filePath === "HUGE.bin") {
        throw new ApiError("File too large to preview", 422);
      }
      const key = filePath.replace(/^\/+/, "");
      return fileContents[key] ?? `// ${key}\n`;
    },

    async getDiff(
      worktreeId: string,
      filePath: string,
      _scope: "local" | "branch",
    ): Promise<string> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      const key = filePath.replace(/^\/+/, "");
      return unifiedDiffs[key] ?? "";
    },

    async tree(worktreeId: string, path: string, scope: FileScope = "worktree"): Promise<TreeEntry[]> {
      // Project scope has no mock tree store — return empty (no crash).
      if (scope === "project") return [];
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      const norm = path.replace(/^\/+/, "").replace(/\/$/, "");
      const entries = treeStore[worktreeId]?.[norm];
      if (!entries) return [];
      return structuredClone(entries);
    },

    async fileList(
      worktreeId: string,
      _signal?: AbortSignal,
      scope: FileScope = "worktree",
    ): Promise<{ files: string[]; truncated: boolean; source: "ripgrep" | "node" }> {
      if (scope === "project") return { files: [], truncated: false, source: "node" };
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      // Walk the mock treeStore to produce a flat list of file paths.
      const out: string[] = [];
      const visited = new Set<string>();
      const walk = (dir: string) => {
        if (visited.has(dir)) return;
        visited.add(dir);
        const entries = treeStore[worktreeId]?.[dir] ?? [];
        for (const e of entries) {
          if (e.type === "dir") walk(e.path);
          else out.push(e.path);
        }
      };
      walk("");
      return { files: out, truncated: false, source: "node" };
    },

    async listChangedPaths(
      worktreeId: string,
      _scope: "local" | "branch" = "local",
    ): Promise<ChangedPathEntry[]> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      if (worktreeId === "wt-1") {
        return Object.keys(unifiedDiffs).map((path) => ({ path, status: "M" as const }));
      }
      return [];
    },

    async listCommits(worktreeId: string, limit = 200): Promise<CommitLogEntry[]> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      const now = new Date("2026-08-11T12:00:00Z").getTime();
      // The first OWN_COMMIT_COUNT entries of `curated` are the worktree's
      // own commits (`isOnBranch: true` below); everything after — the rest
      // of `curated`, plus the whole synthetic tail — simulates base-branch
      // history the worktree forked from, so the VCS tab's collapsed
      // "commits from upstream" group has something to demonstrate. Kept as
      // an explicit count rather than arithmetic on `curated.length` so
      // adding/removing a curated commit above can't silently shift the
      // own/upstream split.
      const OWN_COMMIT_COUNT = 3;
      const curated: Array<[string, string, number, number, string?]> = [
        [
          "Add VCS commit graph skeleton",
          "Ada Lovelace",
          128,
          4,
          "Adds the vertical commit graph tool tab: most-recent-first, per-commit\ndiffstat badges, and a GitHub PR banner when the branch has one.\n\nBacked by a new GET /worktrees/:id/commits endpoint that shells out to\n`git log --numstat` and sums insertions/deletions per commit.",
        ],
        ["Fix double input after fullscreen toggle", "Grace Hopper", 22, 9],
        [
          "Wire up devices panel sub-tabs",
          "Grace Hopper",
          61,
          3,
          "Web and Emulator sub-tabs now share one live view slot instead of\nmounting/unmounting on switch, avoiding the terminal-remount class of bug.",
        ],
        // OWN_COMMIT_COUNT above must match: these two, plus everything in
        // the synthetic tail below, are upstream. The synthetic tail extends
        // this further so "Load more" also has something to demonstrate,
        // since 5 curated commits alone never exceed a page.
        ["Bump lockfile", "Grace Hopper", 4, 4],
        ["Initial worktree scaffold", "Ada Lovelace", 340, 0],
      ];
      const SYNTHETIC_UPSTREAM_COUNT = 120;
      const authors = ["Grace Hopper", "Ada Lovelace", "Katherine Johnson"];
      const sample: Array<[string, string, number, number, string?]> = [
        ...curated,
        ...Array.from({ length: SYNTHETIC_UPSTREAM_COUNT }, (_, j) => {
          const n = j + 1;
          return [
            `Upstream commit #${n}`,
            authors[n % authors.length]!,
            (n % 7) + 1,
            n % 3,
          ] as [string, string, number, number, string?];
        }),
      ];
      const page = sample.slice(0, limit);
      return page.map(([subject, authorName, insertions, deletions, body], i) => ({
        sha: `${worktreeId}-sha-${i}`.padEnd(40, "0"),
        shortSha: `${i}abcdef`.slice(0, 7),
        authorName,
        authorEmail: `${authorName.toLowerCase().replace(/\s+/g, ".")}@example.com`,
        date: new Date(now - i * 3 * 60 * 60 * 1000).toISOString(),
        subject,
        body: body ? `${subject}\n\n${body}` : subject,
        insertions,
        deletions,
        hasBinaryChanges: false,
        isOnBranch: i < OWN_COMMIT_COUNT,
      }));
    },

    async getPr(worktreeId: string): Promise<PrInfo | null> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      if (worktreeId === "wt-1") {
        return {
          number: 42,
          url: "https://github.com/example/example/pull/42",
          title: "Add VCS commit graph skeleton",
          state: "open",
          merged: false,
          draft: false,
          author: "ada-lovelace",
        };
      }
      return null;
    },

    async listSubmodules(worktreeId: string): Promise<SubmoduleInfo[]> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      if (worktreeId === "wt-1") {
        return [
          {
            path: "vendor/widgets",
            sha: "a1b2c3d4e5f6789012345678901234567890abcd",
            shortSha: "a1b2c3d",
            branch: "main",
            subject: "Bump widget renderer to v2",
            status: "clean",
          },
          {
            path: "vendor/legacy",
            sha: "0011223344556677889900112233445566778899",
            shortSha: "0011223",
            branch: null,
            subject: null,
            status: "uninitialized",
          },
        ];
      }
      return [];
    },

    async listModes(): Promise<Mode[]> {
      return structuredClone(modes);
    },

    async getSupportedClis(): Promise<SupportedCli[]> {
      return [
        { id: "claude", defaultModel: "sonnet", supportsJson: true, importsNativeHistory: true, supportsJsonToTerminalResume: true },
        { id: "cursor", defaultModel: "auto", supportsJson: true, importsNativeHistory: false, supportsJsonToTerminalResume: false },
        { id: "opencode", defaultModel: "opencode/big-pickle", supportsJson: true, importsNativeHistory: true, supportsJsonToTerminalResume: true },
        { id: "agy", defaultModel: "Gemini 3.1 Pro (High)", supportsJson: true, importsNativeHistory: false, supportsJsonToTerminalResume: true },
      ];
    },

    async listCliModels(cli: CliId): Promise<{ models: string[]; error?: string }> {
      if (cli === "claude") {
        return {
          models: [
            "sonnet",
            "opus",
            "haiku",
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
          ],
        };
      }
      if (cli === "cursor") {
        return { models: ["auto", "composer-2-fast", "gpt-5.3-codex"] };
      }
      if (cli === "agy") {
        return {
          models: ["Gemini 3.1 Pro (High)", "Gemini 3.5 Flash (Low)", "Claude Sonnet 4.6 (Thinking)"],
        };
      }
      return { models: ["opencode/big-pickle", "opencode/other"] };
    },

    async createMode(body: CreateModeBody): Promise<Mode> {
      if (modes.length >= 10) throw new ApiError("max modes", 400);
      const m: Mode = {
        id: `mode-${Date.now()}`,
        name: body.name,
        cli: body.cli,
        context: body.context,
        presetId: body.presetId,
        ...(body.model ? { model: body.model } : {}),
      };
      modes.push(m);
      emit({ type: "mode:created", mode: m });
      return structuredClone(m);
    },

    async updateMode(id: string, body: UpdateModeBody): Promise<Mode> {
      const m = modes.find((x) => x.id === id);
      if (!m) throw new ApiError("not found", 404);
      if (body.name !== undefined) m.name = body.name;
      if (body.cli !== undefined) m.cli = body.cli;
      if (body.context !== undefined) m.context = body.context;
      if (body.model !== undefined) {
        if (body.model.trim() === "") {
          delete m.model;
        } else {
          m.model = body.model;
        }
      }
      emit({ type: "mode:updated", mode: m });
      return structuredClone(m);
    },

    async deleteMode(id: string): Promise<{ ok: true; affectedSessions: number }> {
      const idx = modes.findIndex((m) => m.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      modes.splice(idx, 1);
      emit({ type: "mode:deleted", modeId: id });
      return { ok: true, affectedSessions: 0 };
    },

    // ── Settings ────────────────────────────────────────────────────────────────

    async getSettings(): Promise<Settings> {
      return { defaultProjectsDir: "/home/user/projects", homeDir: "/home/user" };
    },

    async updateSettings(_body: Partial<Settings>): Promise<{ ok: true }> {
      // Mock does not persist settings
      return { ok: true };
    },

    // ── Create Project ──────────────────────────────────────────────────────────

    async createProject(body: CreateProjectBody): Promise<CreateProjectResponse> {
      const id = body.name;
      const newProject: Project = {
        id,
        name: body.name,
        path: `${body.dir || "/home/user/projects"}/${body.name}`,
        prefix: id.slice(0, 4),
        isGit: true,
        defaultBranch: "main",
        createdAt: nowIso(),
        hidden: false,
      };
      projects.push(newProject);
      emit({ type: "project:created", project: structuredClone(newProject) });

      const response: CreateProjectResponse = { project: structuredClone(newProject) };

      // Mirror the daemon: `startAgent` spawns a worktree+session or a direct
      // session as part of this same call, so mock-mode navigates too.
      if (body.startAgent) {
        const { modeId, useWorktree, branch } = body.startAgent;
        if (useWorktree) {
          const wt: Worktree = {
            id: `wt-${Date.now()}`,
            projectId: id,
            branch: branch?.trim() || "feature",
            baseBranch: "main",
            baseSha: "mock-base-sha",
            createdAt: nowIso(),
            pinnedAt: null,
            hiddenAt: null,
            sortOrder: Date.now(),
          };
          worktrees.push(wt);
          treeStore[wt.id] = { "": [] };
          emit({ type: "worktree:created", worktree: wt });

          const sess: Session = {
            // Independently generated (Decision 1) — never derived from the
            // worktree id, so mock-mode doesn't quietly keep the stale
            // `${wt.id}-m` id-shape assumption alive.
            id: `sess-main-${Date.now()}`,
            worktreeId: wt.id,
            projectId: id,
            modeId: modeId ?? null,
            type: "agent",
            name: null,
            isMain: true,
            state: "working",
            lifecycleState: "working",
            tmuxName: `tmux-${Date.now()}`,
            createdAt: nowIso(),
            sortOrder: Date.now(),
          };
          sessions.push(sess);
          emit({
            type: "session:created",
            sessionId: sess.id,
            worktreeId: wt.id,
            projectId: id,
            sessionType: "agent",
            mode: modeId,
            snapshot: sess,
          });
          response.worktree = wt;
          response.session = sess;
        } else {
          const sess: Session = {
            id: `sess-direct-${Date.now()}`,
            worktreeId: null,
            projectId: id,
            modeId: modeId ?? null,
            type: "agent",
            name: "direct 1",
            isMain: false,
            state: "working",
            lifecycleState: "working",
            tmuxName: `tmux-direct-${Date.now()}`,
            createdAt: nowIso(),
            sortOrder: Date.now(),
          };
          sessions.push(sess);
          emit({
            type: "session:created",
            sessionId: sess.id,
            worktreeId: null,
            projectId: id,
            sessionType: "agent",
            mode: modeId,
            snapshot: sess,
          });
          response.session = sess;
        }
      }

      return response;
    },

    // ── Filesystem autocomplete ──────────────────────────────────────────────────

    async fsComplete(path: string): Promise<FsCompleteResponse> {
      // Mirrors the daemon's R4 completion rule against a small fixed tree:
      // a trailing separator lists the dir's children; otherwise prefix-match
      // child names of the parent dir (no auto-descend on exact-name match).
      let resolved = path;
      if (resolved === "~") resolved = MOCK_HOME;
      else if (resolved.startsWith("~/")) resolved = `${MOCK_HOME}/${resolved.slice(2)}`;

      if (!resolved.startsWith("/")) {
        return { base: resolved, entries: [], truncated: false };
      }

      let dir: string;
      let prefix: string;
      if (resolved.endsWith("/")) {
        dir = resolved.slice(0, -1) || "/";
        prefix = "";
      } else {
        const idx = resolved.lastIndexOf("/");
        dir = idx <= 0 ? "/" : resolved.slice(0, idx);
        prefix = resolved.slice(idx + 1);
      }

      const children = MOCK_FS_TREE[dir] ?? [];
      const entries = children
        .filter((name) => prefix === "" || name.startsWith(prefix))
        .map((name) => ({ name, path: `${dir === "/" ? "" : dir}/${name}` }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      // The fixed mock tree never exceeds MAX_ENTRIES, so this is always
      // false — kept as a real field (not hardcoded at call sites) so it
      // stays structurally identical to the daemon's response.
      return { base: dir, entries, truncated: false };
    },

    async checkFsPath(path: string): Promise<FsCheckResponse> {
      let resolved = path;
      if (resolved === "~") resolved = MOCK_HOME;
      else if (resolved.startsWith("~/")) resolved = `${MOCK_HOME}/${resolved.slice(2)}`;

      // Normalize away trailing slash for lookup
      if (resolved.endsWith("/") && resolved !== "/") {
        resolved = resolved.slice(0, -1);
      }

      const exists = !!MOCK_FS_TREE[resolved] || Object.keys(MOCK_FS_TREE).some(dir => dir.startsWith(resolved + "/"));
      const isDirectory = exists; // mock tree only contains directories
      const isGit = exists && (resolved.includes("project") || resolved.includes("code") || resolved.includes("proj-a") || resolved.includes("proj-b"));
      // Mock dirs are all "already has commits" when they're git — the
      // no-commits-yet hint branch is exercised in tests via a checkFsPath spy.
      const hasCommitsVal = isGit ? true : null;

      return { exists, isDirectory, isGit, hasCommits: hasCommitsVal };
    },

    // ── JSON agent chat (mock) ────────────────────────────────────────────────

    async openChat(sessionId: string, sinceSeq?: number): Promise<void> {
      const events = chatTranscripts.get(sessionId) ?? [];
      if (sinceSeq !== undefined) {
        const delta = events.filter((e) => (e.logSeq ?? -1) > sinceSeq);
        emit({ type: "chat:replay", sessionId, events: structuredClone(delta) });
        return;
      }
      // Bounded tail cursor mirror: the mock has no turn indexing, so replay all
      // and report no older rows (hasMore:false).
      const oldestSeq = events.length ? events[0]!.logSeq : undefined;
      emit({
        type: "chat:replay",
        sessionId,
        events: structuredClone(events),
        ...(oldestSeq !== undefined ? { oldestSeq } : {}),
        hasMore: false,
      });
    },

    async closeChat(_sessionId: string): Promise<void> {},

    async sendChat(
      sessionId: string,
      message: string,
      attachmentIds?: string[],
    ): Promise<SendChatResponse> {
      const turnId = `turn-${++mockTurnSeq}`;
      const userEvent: NormalizedEvent = {
        id: `evt-${Date.now()}-${mockTurnSeq}`,
        sessionId,
        ts: nowIso(),
        provider: "claude",
        kind: "user",
        role: "user",
        text: message,
        turnId,
        ...(attachmentIds?.length
          ? { attachments: attachmentIds.map((id) => ({ id, name: id, path: `/uploads/${id}`, size: 0, mime: "application/octet-stream" })) }
          : {}),
      };
      api.__test.pushChatEvent(sessionId, userEvent);
      emit({ type: "session:message", sessionId, event: userEvent });
      return { turnId, queuePosition: 0 };
    },

    async stopChat(_sessionId: string): Promise<{ ok: true }> {
      return { ok: true };
    },

    async cancelQueuedTurn(_sessionId: string, _turnId: string): Promise<{ ok: true }> {
      return { ok: true };
    },

    async beginEditQueuedTurn(sessionId: string, turnId: string): Promise<BeginEditResponse> {
      const events = chatTranscripts.get(sessionId) ?? [];
      // Last `user` event for this turn wins (mirrors edited-supersede semantics).
      const userEv = [...events].reverse().find((e) => e.kind === "user" && e.turnId === turnId);
      return {
        turnId,
        message: userEv?.text ?? "",
        attachments: userEv?.attachments ?? [],
        queueIndex: 0,
      };
    },

    async resubmitQueuedTurn(
      sessionId: string,
      turnId: string,
      body: { edited: boolean; message?: string; attachmentIds?: string[] },
    ): Promise<{ ok: true; turnId: string }> {
      if (body.edited) {
        const userEvent: NormalizedEvent = {
          id: `evt-${Date.now()}-${++mockTurnSeq}`,
          sessionId,
          ts: nowIso(),
          provider: "claude",
          kind: "user",
          role: "user",
          text: body.message ?? "",
          turnId,
          edited: true,
          ...(body.attachmentIds?.length
            ? { attachments: body.attachmentIds.map((id) => ({ id, name: id, path: `/uploads/${id}`, size: 0, mime: "application/octet-stream" })) }
            : {}),
        };
        api.__test.pushChatEvent(sessionId, userEvent);
        emit({ type: "session:message", sessionId, event: userEvent });
      }
      return { ok: true, turnId };
    },

    async promoteQueuedTurn(_sessionId: string, turnId: string): Promise<{ ok: true; turnId: string }> {
      return { ok: true, turnId };
    },

    async forkChat(
      sessionId: string,
      turnId: string,
      message: string,
      attachmentIds?: string[],
    ): Promise<{ ok: true; turnId: string }> {
      // Truncate at the forked turn: everything from that turn onward is dropped
      // (superseded), then the edited message runs as a fresh turn (mirrors R3.4).
      const events = chatTranscripts.get(sessionId) ?? [];
      const forkIdx = events.findIndex((e) => e.turnId === turnId);
      const supersededTurnIds = new Set<string>();
      if (forkIdx >= 0) {
        for (const e of events.slice(forkIdx)) if (e.turnId) supersededTurnIds.add(e.turnId);
        chatTranscripts.set(sessionId, events.slice(0, forkIdx));
      }
      emit({ type: "session:fork", sessionId, supersededTurnIds: [...supersededTurnIds] });
      const newTurnId = `turn-${++mockTurnSeq}`;
      const userEvent: NormalizedEvent = {
        id: `evt-${Date.now()}-${mockTurnSeq}`,
        sessionId,
        ts: nowIso(),
        provider: "claude",
        kind: "user",
        role: "user",
        text: message,
        turnId: newTurnId,
        ...(attachmentIds?.length
          ? { attachments: attachmentIds.map((id) => ({ id, name: id, path: `/uploads/${id}`, size: 0, mime: "application/octet-stream" })) }
          : {}),
      };
      api.__test.pushChatEvent(sessionId, userEvent);
      emit({ type: "session:message", sessionId, event: userEvent });
      return { ok: true, turnId: newTurnId };
    },

    async setSessionModel(
      _sessionId: string,
      model: string | null,
    ): Promise<{ ok: true; model: string | null }> {
      return { ok: true, model };
    },

    async setSessionChannel(
      sessionId: string,
      channel: Channel,
    ): Promise<{ ok: true; channel: Channel }> {
      const s = sessions.find((x) => x.id === sessionId);
      if (s) {
        s.channel = channel;
        s.useTmux = channel === "tmux";
        // Mirror the switch to other tabs (R1.7): patch the session record + meta.
        emit({ type: "session:updated", sessionId, channel });
        emit({
          type: "session:meta",
          sessionId,
          meta: {
            sessionId,
            channel,
            cli: "claude",
            turnState: "idle",
            queueDepth: 0,
            queuedTurnIds: [],
            editingTurnIds: [],
          },
        });
      }
      return { ok: true, channel };
    },

    async uploadAttachments(_sessionId: string, files: File[]): Promise<UploadAttachmentsResponse> {
      const attachments: Attachment[] = files.map((f, i) => ({
        id: `att-${Date.now()}-${i}`,
        name: f.name,
        path: `/mock/uploads/${f.name}`,
        size: f.size,
        mime: f.type || "application/octet-stream",
      }));
      return { attachments };
    },

    async deleteAttachment(_sessionId: string, _uploadId: string): Promise<{ ok: true }> {
      return { ok: true };
    },

    async getTranscript(sessionId: string): Promise<TranscriptResponse> {
      return { events: structuredClone(chatTranscripts.get(sessionId) ?? []) };
    },

    async getTranscriptPage(
      sessionId: string,
      beforeSeq: number,
      limit = 20,
    ): Promise<TranscriptPage> {
      const events = chatTranscripts.get(sessionId) ?? [];
      const older = events.filter((e) => (e.logSeq ?? -1) < beforeSeq);
      const page = older.slice(Math.max(0, older.length - limit));
      return {
        events: structuredClone(page),
        ...(page.length ? { oldestSeq: page[0]!.logSeq } : {}),
        hasMore: page.length < older.length,
      };
    },

    async getTranscriptAll(sessionId: string): Promise<TranscriptResponse> {
      return { events: structuredClone(chatTranscripts.get(sessionId) ?? []) };
    },

    async getMeta(sessionId: string): Promise<SessionMeta> {
      return {
        sessionId,
        channel: "json",
        cli: "claude",
        turnState: "idle",
        queueDepth: 0,
        queuedTurnIds: [],
        editingTurnIds: [],
      };
    },

    subscribe(sessionIds: string[]): () => void {
      for (const id of sessionIds) {
        subscribed.add(id);
        const s = sessions.find((x) => x.id === id);
        if (s?.state === "working") {
          startOutputSimulation(id);
        }
      }
      return () => {
        for (const id of sessionIds) {
          subscribed.delete(id);
          const t = outputTimers.get(id);
          if (t) {
            clearInterval(t);
            outputTimers.delete(id);
          }
        }
      };
    },

    on(type: WSEvent["type"] | "*", handler: (e: WSEvent) => void): () => void {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => {
        const set = listeners.get(type);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) listeners.delete(type);
      };
    },

    startConnection(): void {},
    getConnectionState(): "online" | "connecting" | "offline" {
      return "online";
    },
    subscribeConnection(handler: (s: "online" | "connecting" | "offline") => void): () => void {
      handler("online");
      return () => {};
    },

    // Auth — mock always succeeds (no auth in test/mock mode)
    async login(_token: string): Promise<void> {},
    async logout(): Promise<void> {},
    async checkAuth(): Promise<boolean> { return true; },
  };

  return api;
}

export type MockApi = ReturnType<typeof createMockApi>;
