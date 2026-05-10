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

function baseUrl() {
  const raw = import.meta.env.VITE_DAEMON_URL ?? "";
  return raw.trim() || "/api";
}

function wsUrl() {
  const base = baseUrl();
  // Relative base (e.g. "/api") — connect to /ws on the same origin (Vite proxies it).
  if (base.startsWith("/")) {
    return `${window.location.origin.replace(/^http/, "ws")}/ws`;
  }
  const u = new URL(base);
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

/** Thin fetch wrapper that always sends credentials (session cookie).
 *  credentials: 'include' is required because in dev the web UI (port 5173)
 *  and daemon (port 7421) are different origins — 'same-origin' would silently
 *  drop the cookie. */
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: { ...init?.headers },
  });
}

export type ConnectionState = "online" | "connecting" | "offline";
export type AuthEvent = { type: "auth:expired" };

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

export function createClientApi() {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  /** Ref-counted subs: multiple components can sub to the same sessionId without
   *  one cleanup tearing down the others. */
  const subRefs = new Map<string, number>();
  /** Active file/tree watchers — replayed on WS reconnect so the daemon's
   *  per-connection chokidar state survives a drop. Keyed by stringified
   *  payload to deduplicate. */
  const fileWatches = new Map<string, { worktreeId: string; path: string }>();
  const treeWatches = new Map<string, { worktreeId: string }>();
  let wsReadyPromise: Promise<void> | null = null;
  const listeners = new Map<string, Set<(e: WSEvent) => void>>();

  let connState: ConnectionState = "offline";
  const connListeners = new Set<(s: ConnectionState) => void>();
  function setConnState(s: ConnectionState) {
    if (connState === s) return;
    connState = s;
    for (const h of connListeners) h(s);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const jitter = Math.random() * 0.3 * backoffMs;
    const delay = backoffMs + jitter;
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(backoffMs * 1.7));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureWs();
    }, delay);
  }

  function emit(ev: WSEvent) {
    const star = listeners.get("*");
    if (star) for (const h of star) h(ev);
    const typed = listeners.get(ev.type);
    if (typed) for (const h of typed) h(ev);
  }

  function ensureWs(): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (wsReadyPromise) return wsReadyPromise;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setConnState("connecting");
    wsReadyPromise = new Promise<void>((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        wsReadyPromise = null;
        setConnState("offline");
        scheduleReconnect();
        resolve();
        return;
      }
      ws = socket;
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WSEvent & { type?: string };
          if (msg.type) emit(msg as WSEvent);
        } catch {
          /* ignore */
        }
      };
      socket.onopen = () => {
        backoffMs = INITIAL_BACKOFF_MS;
        setConnState("online");
        if (subRefs.size > 0) {
          socket.send(JSON.stringify({ type: "subscribe", sessionIds: [...subRefs.keys()] }));
        }
        // Replay file/tree watches — daemon's per-connection chokidar state
        // is gone after a drop, so without this the FilePreviewPane silently
        // stops receiving file:changed events until the user remounts it.
        for (const w of fileWatches.values()) {
          socket.send(JSON.stringify({ type: "file:watch", worktreeId: w.worktreeId, path: w.path }));
        }
        for (const w of treeWatches.values()) {
          socket.send(JSON.stringify({ type: "tree:watch", worktreeId: w.worktreeId }));
        }
        wsReadyPromise = null;
        resolve();
      };
      socket.onerror = () => {
        // close handler will follow and own the reconnect
      };
      socket.onclose = (ev) => {
        if (ws === socket) ws = null;
        wsReadyPromise = null;
        setConnState("offline");
        // Code 4401 = daemon rejected the WS connection due to expired/missing
        // session. Do NOT reconnect — that would hammer the daemon in a tight loop.
        // Instead emit an auth:expired event so the UI can show the LoginScreen.
        if (ev.code === 4401) {
          emit({ type: "auth:expired" } as unknown as WSEvent);
          resolve();
          return;
        }
        scheduleReconnect();
        resolve();
      };
    });
    return wsReadyPromise;
  }

  async function sendWs(payload: Record<string, unknown>) {
    await ensureWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  const api = {
    async health(): Promise<HealthResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/health`);
      return parseJson<HealthResponse>(res);
    },

    async listProjects(): Promise<Project[]> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects`);
      return parseJson<Project[]>(res);
    },

    async deleteProject(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async listWorktrees(projectId?: string): Promise<Worktree[]> {
      const root = baseUrl();
      const url = projectId
        ? `${root}/worktrees?${new URLSearchParams({ project: projectId })}`
        : `${root}/worktrees`;
      const res = await apiFetch(url);
      return parseJson<Worktree[]>(res);
    },

    async createWorktree(body: CreateWorktreeBody): Promise<Worktree> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Worktree>(res);
    },

    async deleteWorktree(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      // UI always purges (removes files from disk)
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}?purge=true`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async dismissWorktree(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async markWorktreeDone(id: string): Promise<{ ok: true; updated: number }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/done`, {
        method: "POST",
      });
      return parseJson<{ ok: true; updated: number }>(res);
    },

    async listSessions(worktreeId?: string): Promise<Session[]> {
      const root = baseUrl();
      const url = worktreeId
        ? `${root}/sessions?${new URLSearchParams({ worktree: worktreeId })}`
        : `${root}/sessions`;
      const res = await apiFetch(url);
      return parseJson<Session[]>(res);
    },

    async createSession(body: CreateSessionBody): Promise<Session> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Session>(res);
    },

    async deleteSession(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async resumeSession(id: string): Promise<Session> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/resume`, {
        method: "POST",
      });
      return parseJson<Session>(res);
    },

    async sendInput(sessionId: string, body: SendInputBody): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return parseJson<{ ok: true }>(res);
    },

    async getFile(worktreeId: string, filePath: string): Promise<string> {
      const path = filePath.replace(/^\/+/, "");
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(worktreeId)}/files/${path}`);
      if (res.status === 422) throw new ApiError("File too large to preview", 422);
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try {
          const j = JSON.parse(text) as { error?: string; message?: string };
          msg = j.error ?? j.message ?? text;
        } catch { /* not JSON, keep raw text */ }
        throw new ApiError(msg, res.status);
      }
      return res.text();
    },

    async getDiff(
      worktreeId: string,
      filePath: string,
      scope: "local" | "branch",
    ): Promise<string> {
      const path = filePath.replace(/^\/+/, "");
      const q = new URLSearchParams({ scope });
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/worktrees/${encodeURIComponent(worktreeId)}/diff/${path}?${q}`,
      );
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 422) {
          try {
            const j = JSON.parse(text) as { message?: string; error?: string };
            throw new ApiError(j.message ?? j.error ?? text, 422);
          } catch (e) {
            if (e instanceof ApiError) throw e;
            throw new ApiError(text, 422);
          }
        }
        throw new ApiError(text || res.statusText, res.status);
      }
      return text;
    },

    async tree(worktreeId: string, path: string): Promise<TreeEntry[]> {
      const q = new URLSearchParams({ path: path.replace(/^\/+/, "") });
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/worktrees/${encodeURIComponent(worktreeId)}/tree?${q}`,
      );
      return parseJson<TreeEntry[]>(res);
    },

    async listChangedPaths(
      worktreeId: string,
      scope: "local" | "branch" = "local",
    ): Promise<ChangedPathEntry[]> {
      const q = new URLSearchParams({ scope });
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/worktrees/${encodeURIComponent(worktreeId)}/changed-paths?${q}`,
      );
      return parseJson<ChangedPathEntry[]>(res);
    },

    async listModes(): Promise<Mode[]> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/modes`);
      return parseJson<Mode[]>(res);
    },

    async getSupportedClis(): Promise<SupportedCli[]> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/supported-clis`);
      return parseJson<SupportedCli[]>(res);
    },

    async listCliModels(cli: CliId): Promise<{ models: string[]; error?: string }> {
      const root = baseUrl();
      const q = new URLSearchParams({ cli });
      const res = await apiFetch(`${root}/cli-models?${q}`);
      return parseJson<{ models: string[]; error?: string }>(res);
    },

    async createMode(body: CreateModeBody): Promise<Mode> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/modes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Mode>(res);
    },

    async updateMode(id: string, body: UpdateModeBody): Promise<Mode> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/modes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Mode>(res);
    },

    async deleteMode(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/modes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async send(message: {
      type: "file:watch" | "file:unwatch" | "tree:watch" | "tree:unwatch" | "ping";
      worktreeId?: string;
      path?: string;
    }): Promise<void> {
      // Track watches so they can be re-sent on reconnect.
      if (message.worktreeId) {
        if (message.type === "file:watch" && message.path) {
          fileWatches.set(`${message.worktreeId}:${message.path}`, {
            worktreeId: message.worktreeId,
            path: message.path,
          });
        } else if (message.type === "file:unwatch" && message.path) {
          fileWatches.delete(`${message.worktreeId}:${message.path}`);
        } else if (message.type === "tree:watch") {
          treeWatches.set(message.worktreeId, { worktreeId: message.worktreeId });
        } else if (message.type === "tree:unwatch") {
          treeWatches.delete(message.worktreeId);
        }
      }
      await sendWs(message);
    },

    async openSession(sessionId: string, cols: number, rows: number): Promise<void> {
      await sendWs({ type: "session:open", sessionId, cols, rows });
    },

    async closeSession(sessionId: string): Promise<void> {
      await sendWs({ type: "session:close", sessionId });
    },

    async sendKeystroke(sessionId: string, data: string): Promise<void> {
      await sendWs({ type: "session:input", sessionId, data });
    },

    async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
      await sendWs({ type: "session:resize", sessionId, cols, rows });
    },

    subscribe(sessionIds: string[]): () => void {
      const newlyAdded: string[] = [];
      for (const id of sessionIds) {
        const prev = subRefs.get(id) ?? 0;
        if (prev === 0) newlyAdded.push(id);
        subRefs.set(id, prev + 1);
      }
      if (newlyAdded.length > 0) {
        void ensureWs().then(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "subscribe", sessionIds: newlyAdded }));
          }
        });
      }
      return () => {
        const removed: string[] = [];
        for (const id of sessionIds) {
          const prev = subRefs.get(id) ?? 0;
          if (prev <= 1) {
            subRefs.delete(id);
            removed.push(id);
          } else {
            subRefs.set(id, prev - 1);
          }
        }
        if (removed.length > 0 && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", sessionIds: removed }));
        }
        // Keep WS alive for the lifetime of the API instance — closing/reopening
        // on every transient sub change caused message loss + connection thrash.
      };
    },

    on(type: WSEvent["type"] | "*", handler: (e: WSEvent) => void): () => void {
      const key = type;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(handler);
      return () => {
        const set = listeners.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) listeners.delete(key);
      };
    },

    /** Open the WS eagerly so we observe online/offline transitions even before
     *  the first subscription. */
    startConnection(): void {
      void ensureWs();
    },

    // ── Auth ──────────────────────────────────────────────────────────────────

    /** Exchange the daemon token for a session cookie. Throws ApiError on failure. */
    async login(token: string): Promise<void> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await parseJson<{ ok: true }>(res);
    },

    /** Clear the session cookie (server side). */
    async logout(): Promise<void> {
      const root = baseUrl();
      await apiFetch(`${root}/auth/logout`, { method: "POST" });
    },

    /** Returns true if the current session cookie is valid. */
    async checkAuth(): Promise<boolean> {
      try {
        const root = baseUrl();
        const res = await apiFetch(`${root}/auth/check`);
        return res.ok;
      } catch {
        return false;
      }
    },

    getConnectionState(): ConnectionState {
      return connState;
    },

    /** Subscribe to connection-state changes. Calls handler immediately with the
     *  current state, then on every transition. Returns an unsubscribe fn. */
    subscribeConnection(handler: (s: ConnectionState) => void): () => void {
      connListeners.add(handler);
      handler(connState);
      return () => {
        connListeners.delete(handler);
      };
    },
  };

  return api;
}
