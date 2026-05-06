import type {
  ChangedPathEntry,
  CliId,
  CreateModeBody,
  CreateSessionBody,
  CreateWorktreeBody,
  HealthResponse,
  Mode,
  Project,
  SendInputBody,
  Session,
  SupportedCli,
  TreeEntry,
  UpdateModeBody,
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

export function createMockApi() {
  const projects: Project[] = [
    {
      id: "proj-a",
      name: "Proj A",
      path: "/home/dev/proj-a",
      prefix: "pa",
      defaultBranch: "main",
      createdAt: nowIso(),
    },
    {
      id: "proj-b",
      name: "Proj B",
      path: "/home/dev/proj-b",
      prefix: "pb",
      defaultBranch: "develop",
      createdAt: nowIso(),
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
    },
    {
      id: "wt-2",
      projectId: "proj-a",
      branch: "wt-2",
      baseBranch: "main",
      baseSha: "def456",
      createdAt: nowIso(),
    },
    {
      id: "wt-3",
      projectId: "proj-b",
      branch: "wt-main",
      baseBranch: "develop",
      baseSha: "fed789",
      createdAt: nowIso(),
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
      modeId: "mode-1",
      type: "agent",
      label: "main",
      slot: "m",
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-main",
      createdAt: nowIso(),
    },
    {
      id: "sess-agent2",
      worktreeId: "wt-1",
      modeId: "mode-2",
      type: "agent",
      label: "agent-2",
      slot: "a1",
      state: "idle",
      lifecycleState: "idle",
      tmuxName: "sess-agent2",
      createdAt: nowIso(),
    },
    {
      id: "sess-term1",
      worktreeId: "wt-1",
      modeId: null,
      type: "terminal",
      label: "term-1",
      slot: "t1",
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-term1",
      createdAt: nowIso(),
    },
    {
      id: "sess-wt2-main",
      worktreeId: "wt-2",
      modeId: "mode-1",
      type: "agent",
      label: "main",
      slot: "m",
      state: "done",
      lifecycleState: "done",
      tmuxName: "sess-wt2-main",
      createdAt: nowIso(),
    },
    {
      id: "sess-wt3-main",
      worktreeId: "wt-3",
      modeId: "mode-1",
      type: "agent",
      label: "main",
      slot: "m",
      state: "idle",
      lifecycleState: "idle",
      tmuxName: "sess-wt3-main",
      createdAt: nowIso(),
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

  const api = {
    __test: {
      simulateExit,
      emit,
      setDaemonDown(v: boolean) {
        daemonDown = v;
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

    async deleteProject(_id: string): Promise<{ ok: true }> {
      emit({ type: "project:deleted", projectId: _id });
      return { ok: true };
    },

    async listWorktrees(projectId: string): Promise<Worktree[]> {
      return structuredClone(worktrees.filter((w) => w.projectId === projectId));
    },

    async createWorktree(body: CreateWorktreeBody): Promise<Worktree> {
      const wt: Worktree = {
        id: `wt-${Date.now()}`,
        projectId: body.projectId,
        branch: body.branch,
        baseBranch: body.baseBranch ?? "main",
        baseSha: "mock-base-sha",
        createdAt: nowIso(),
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
      worktrees.splice(idx, 1);
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i]!.worktreeId === id) sessions.splice(i, 1);
      }
      delete treeStore[id];
      emit({ type: "worktree:deleted", worktreeId: id });
      return { ok: true };
    },

    async dismissWorktree(id: string): Promise<{ ok: true }> {
      const idx = worktrees.findIndex((w) => w.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      worktrees.splice(idx, 1);
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i]!.worktreeId === id) sessions.splice(i, 1);
      }
      emit({ type: "worktree:deleted", worktreeId: id });
      return { ok: true };
    },

    async markWorktreeDone(id: string): Promise<{ ok: true; updated: number }> {
      const wtExists = worktrees.some((w) => w.id === id);
      const agents = sessions.filter((s) => s.worktreeId === id && s.type === "agent");
      if (!wtExists) throw new ApiError("not found", 404);
      let updated = 0;
      for (const s of agents) {
        s.state = "done";
        s.lifecycleState = "done";
        emit({ type: "session:state", sessionId: s.id, state: "done" });
        updated += 1;
      }
      return { ok: true, updated };
    },

    async listSessions(worktreeId: string): Promise<Session[]> {
      return structuredClone(sessions.filter((s) => s.worktreeId === worktreeId));
    },

    async createSession(body: CreateSessionBody): Promise<Session> {
      const wtSessions = sessions.filter((s) => s.worktreeId === body.worktreeId);
      const nextAgent = wtSessions.filter((s) => s.slot.startsWith("a")).length + 1;
      const nextTerm = wtSessions.filter((s) => s.slot.startsWith("t")).length + 1;
      const slot =
        body.type === "terminal" ? `t${nextTerm}` : `a${nextAgent}`;
      const sess: Session = {
        id: `sess-${Date.now()}`,
        worktreeId: body.worktreeId,
        modeId: body.modeId,
        type: body.type,
        label: body.type === "terminal" ? `term-${nextTerm}` : `agent-${nextAgent}`,
        slot,
        state: "working",
        lifecycleState: "working",
        tmuxName: `tmux-${Date.now()}`,
        createdAt: nowIso(),
      };
      sessions.push(sess);
      emit({
        type: "session:created",
        sessionId: sess.id,
        worktreeId: sess.worktreeId,
        sessionType: sess.type,
        mode: typeof body.modeId === "string" ? body.modeId : undefined,
        snapshot: sess,
      });
      return structuredClone(sess);
    },

    async deleteSession(id: string): Promise<{ ok: true }> {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      const victim = sessions[idx];
      if (!victim) throw new ApiError("not found", 404);
      if (victim.slot === "m") throw new ApiError("cannot delete main", 400);
      sessions.splice(idx, 1);
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

    async sendInput(sessionId: string, body: SendInputBody): Promise<{ ok: true }> {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new ApiError("not found", 404);
      emit({
        type: "session:output",
        sessionId,
        chunk: body.data,
      });
      return { ok: true };
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

    async getFile(worktreeId: string, filePath: string): Promise<string> {
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

    async tree(worktreeId: string, path: string): Promise<TreeEntry[]> {
      if (!worktrees.find((w) => w.id === worktreeId)) throw new ApiError("not found", 404);
      const norm = path.replace(/^\/+/, "").replace(/\/$/, "");
      const entries = treeStore[worktreeId]?.[norm];
      if (!entries) return [];
      return structuredClone(entries);
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

    async listModes(): Promise<Mode[]> {
      return structuredClone(modes);
    },

    async getSupportedClis(): Promise<SupportedCli[]> {
      return [
        { id: "claude", defaultModel: "sonnet" },
        { id: "cursor", defaultModel: "auto" },
        { id: "opencode", defaultModel: "opencode/big-pickle" },
        { id: "gemini", defaultModel: "gemini-2.5-pro" },
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
      if (cli === "gemini") {
        return {
          models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
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

    async deleteMode(id: string): Promise<{ ok: true }> {
      const idx = modes.findIndex((m) => m.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      modes.splice(idx, 1);
      emit({ type: "mode:deleted", modeId: id });
      return { ok: true };
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
  };

  return api;
}

export type MockApi = ReturnType<typeof createMockApi>;
