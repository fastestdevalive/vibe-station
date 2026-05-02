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

function baseUrl() {
  return import.meta.env.VITE_DAEMON_URL ?? "http://127.0.0.1:7421";
}

function wsUrl() {
  const u = new URL(baseUrl());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  return u.toString();
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(text || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export function createClientApi() {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingSubs = new Set<string>();
  let eventCallback: ((e: WSEvent) => void) | null = null;

  function ensureWs() {
    if (ws?.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(wsUrl());
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WSEvent & { type?: string };
        if (msg.type && eventCallback) {
          eventCallback(msg as WSEvent);
        }
      } catch {
        /* ignore */
      }
    };
    ws.onopen = () => {
      if (pendingSubs.size > 0 && ws) {
        ws.send(JSON.stringify({ type: "subscribe", sessionIds: [...pendingSubs] }));
      }
    };
    ws.onclose = () => {
      reconnectTimer = setTimeout(ensureWs, 1000);
    };
  }

  const api = {
    async health(): Promise<HealthResponse> {
      const res = await fetch(`${baseUrl()}/health`);
      return parseJson<HealthResponse>(res);
    },

    async listProjects(): Promise<Project[]> {
      const res = await fetch(`${baseUrl()}/projects`);
      return parseJson<Project[]>(res);
    },

    async deleteProject(id: string): Promise<{ ok: true }> {
      const res = await fetch(`${baseUrl()}/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async listWorktrees(projectId: string): Promise<Worktree[]> {
      const q = new URLSearchParams({ project: projectId });
      const res = await fetch(`${baseUrl()}/worktrees?${q}`);
      return parseJson<Worktree[]>(res);
    },

    async createWorktree(body: CreateWorktreeBody): Promise<Worktree> {
      const res = await fetch(`${baseUrl()}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Worktree>(res);
    },

    async deleteWorktree(id: string): Promise<{ ok: true }> {
      const res = await fetch(`${baseUrl()}/worktrees/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async listSessions(worktreeId: string): Promise<Session[]> {
      const q = new URLSearchParams({ worktree: worktreeId });
      const res = await fetch(`${baseUrl()}/sessions?${q}`);
      return parseJson<Session[]>(res);
    },

    async createSession(body: CreateSessionBody): Promise<Session> {
      const res = await fetch(`${baseUrl()}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Session>(res);
    },

    async deleteSession(id: string): Promise<{ ok: true }> {
      const res = await fetch(`${baseUrl()}/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async resumeSession(id: string): Promise<Session> {
      const res = await fetch(`${baseUrl()}/sessions/${encodeURIComponent(id)}/resume`, {
        method: "POST",
      });
      return parseJson<Session>(res);
    },

    async sendInput(sessionId: string, body: SendInputBody): Promise<{ ok: true }> {
      const res = await fetch(
        `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return parseJson<{ ok: true }>(res);
    },

    async getFile(sessionId: string, filePath: string): Promise<string> {
      const path = filePath.replace(/^\/+/, "");
      const res = await fetch(`${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/files/${path}`);
      if (res.status === 422) throw new ApiError("File too large to preview", 422);
      if (!res.ok) throw new ApiError(await res.text(), res.status);
      return res.text();
    },

    async getDiff(
      sessionId: string,
      filePath: string,
      scope: "local" | "branch",
    ): Promise<string> {
      const path = filePath.replace(/^\/+/, "");
      const q = new URLSearchParams({ scope });
      const res = await fetch(
        `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/diff/${path}?${q}`,
      );
      if (!res.ok) throw new ApiError(await res.text(), res.status);
      return res.text();
    },

    async tree(sessionId: string, path: string): Promise<TreeEntry[]> {
      const q = new URLSearchParams({ path: path.replace(/^\/+/, "") });
      const res = await fetch(
        `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/tree?${q}`,
      );
      return parseJson<TreeEntry[]>(res);
    },

    async listChangedPaths(sessionId: string): Promise<ChangedPathEntry[]> {
      const res = await fetch(
        `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/changed-paths`,
      );
      if (!res.ok) throw new ApiError(await res.text(), res.status);
      return parseJson<ChangedPathEntry[]>(res);
    },

    async listModes(): Promise<Mode[]> {
      const res = await fetch(`${baseUrl()}/modes`);
      return parseJson<Mode[]>(res);
    },

    async createMode(body: CreateModeBody): Promise<Mode> {
      const res = await fetch(`${baseUrl()}/modes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Mode>(res);
    },

    async updateMode(id: string, body: UpdateModeBody): Promise<Mode> {
      const res = await fetch(`${baseUrl()}/modes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Mode>(res);
    },

    async deleteMode(id: string): Promise<{ ok: true }> {
      const res = await fetch(`${baseUrl()}/modes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    subscribe(sessionIds: string[], onEvent: (e: WSEvent) => void): () => void {
      eventCallback = onEvent;
      for (const id of sessionIds) {
        pendingSubs.add(id);
      }
      ensureWs();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "subscribe", sessionIds }));
      }
      return () => {
        for (const id of sessionIds) {
          pendingSubs.delete(id);
        }
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", sessionIds }));
        }
        if (pendingSubs.size === 0) {
          eventCallback = null;
          ws?.close();
          ws = null;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
        }
      };
    },
  };

  return api;
}
