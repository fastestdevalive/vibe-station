import type {
  ChangedPathEntry,
  CreateModeBody,
  CreateSessionBody,
  CreateWorktreeBody,
  HealthResponse,
  Mode,
  Project,
  SendInputBody,
  Session,
  TreeEntry,
  UpdateModeBody,
  WSEvent,
  Worktree,
} from "./types";
import { ApiError } from "./errors";

type Listener = (ev: WSEvent) => void;

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
      createdAt: nowIso(),
    },
    {
      id: "proj-b",
      name: "Proj B",
      path: "/home/dev/proj-b",
      createdAt: nowIso(),
    },
  ];

  const worktrees: Worktree[] = [
    {
      id: "wt-1",
      projectId: "proj-a",
      name: "wt-1",
      baseBranch: "main",
      createdAt: nowIso(),
    },
    {
      id: "wt-2",
      projectId: "proj-a",
      name: "wt-2",
      baseBranch: "main",
      createdAt: nowIso(),
    },
    {
      id: "wt-3",
      projectId: "proj-b",
      name: "wt-main",
      baseBranch: "develop",
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

  const listeners = new Set<Listener>();
  const outputTimers = new Map<string, ReturnType<typeof setInterval>>();
  const subscribed = new Set<string>();

  function emit(ev: WSEvent) {
    for (const l of listeners) {
      l(ev);
    }
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
    emit({ type: "session:exited", sessionId, exitCode: 1 });
    emit({ type: "session:state", sessionId, state: "exited" });
  }

  let daemonDown = false;

  const api = {
    __test: {
      simulateExit,
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
      return { ok: true };
    },

    async listWorktrees(projectId: string): Promise<Worktree[]> {
      return structuredClone(worktrees.filter((w) => w.projectId === projectId));
    },

    async createWorktree(body: CreateWorktreeBody): Promise<Worktree> {
      const wt: Worktree = {
        id: `wt-${Date.now()}`,
        projectId: body.projectId,
        name: body.name,
        baseBranch: body.baseBranch,
        createdAt: nowIso(),
      };
      worktrees.push(wt);
      treeStore[wt.id] = {
        "": [],
      };
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
      return { ok: true };
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
        createdAt: nowIso(),
      };
      sessions.push(sess);
      const mode = body.modeId ? modes.find((m) => m.id === body.modeId) ?? null : null;
      emit({
        type: "session:created",
        sessionId: sess.id,
        worktreeId: sess.worktreeId,
        sessionType: sess.type,
        mode,
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

    async getFile(sessionId: string, filePath: string): Promise<string> {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new ApiError("not found", 404);
      if (filePath === "HUGE.bin") {
        throw new ApiError("File too large to preview", 422);
      }
      const key = filePath.replace(/^\/+/, "");
      return fileContents[key] ?? `// ${key}\n`;
    },

    async getDiff(
      sessionId: string,
      filePath: string,
      _scope: "local" | "branch",
    ): Promise<string> {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new ApiError("not found", 404);
      const key = filePath.replace(/^\/+/, "");
      return unifiedDiffs[key] ?? "";
    },

    async tree(sessionId: string, path: string): Promise<TreeEntry[]> {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new ApiError("not found", 404);
      const wt = s.worktreeId;
      const norm = path.replace(/^\/+/, "").replace(/\/$/, "");
      const entries = treeStore[wt]?.[norm];
      if (!entries) return [];
      return structuredClone(entries);
    },

    async listChangedPaths(sessionId: string): Promise<ChangedPathEntry[]> {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new ApiError("not found", 404);
      const wt = s.worktreeId;
      if (wt === "wt-1") {
        return Object.keys(unifiedDiffs).map((path) => ({ path, status: "M" as const }));
      }
      return [];
    },

    async listModes(): Promise<Mode[]> {
      return structuredClone(modes);
    },

    async createMode(body: CreateModeBody): Promise<Mode> {
      if (modes.length >= 10) throw new ApiError("max modes", 400);
      const m: Mode = {
        id: `mode-${Date.now()}`,
        name: body.name,
        cli: body.cli,
        context: body.context,
        presetId: body.presetId,
      };
      modes.push(m);
      return structuredClone(m);
    },

    async updateMode(id: string, body: UpdateModeBody): Promise<Mode> {
      const m = modes.find((x) => x.id === id);
      if (!m) throw new ApiError("not found", 404);
      if (body.name !== undefined) m.name = body.name;
      if (body.cli !== undefined) m.cli = body.cli;
      if (body.context !== undefined) m.context = body.context;
      return structuredClone(m);
    },

    async deleteMode(id: string): Promise<{ ok: true }> {
      const idx = modes.findIndex((m) => m.id === id);
      if (idx === -1) throw new ApiError("not found", 404);
      modes.splice(idx, 1);
      return { ok: true };
    },

    subscribe(sessionIds: string[], onEvent: Listener): () => void {
      listeners.add(onEvent);
      for (const id of sessionIds) {
        subscribed.add(id);
        const s = sessions.find((x) => x.id === id);
        if (s?.state === "working") {
          startOutputSimulation(id);
        }
      }
      return () => {
        listeners.delete(onEvent);
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
  };

  return api;
}

export type MockApi = ReturnType<typeof createMockApi>;
