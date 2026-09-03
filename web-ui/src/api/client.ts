import type {
  AddProjectBody,
  AddProjectResponse,
  BeginEditResponse,
  ChangedPathEntry,
  Channel,
  CliId,
  CommitLogEntry,
  PrInfo,
  PrLookupResult,
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

/**
 * Base path for file-browsing endpoints. Worktree scope is git-aware; project
 * scope serves plain files from the project base dir (direct sessions).
 */
function fileBase(scope: FileScope, id: string): string {
  const seg = scope === "project" ? "projects" : "worktrees";
  return `${baseUrl()}/${seg}/${encodeURIComponent(id)}`;
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
  /** Refcounted JSON-chat subscriptions — multiple components can subscribe to
   *  the same sessionId without one cleanup tearing down the others.
   *  Map<sessionId, { refs, sinceSeq? }>; chat:open sent on 0→1, chat:close sent on 1→0.
   *  `sinceSeq` is stored on the 0→1 transition so WS-reconnect replays can use
   *  the same delta cursor instead of requesting a full tail (cold-start double-open fix). */
  const chatSubs = new Map<string, { refs: number; sinceSeq?: number }>();
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
          if (msg.type) {
            emit(msg as WSEvent);
            // Fix 3: advance the stored sinceSeq cursor as live session:message
            // events arrive so WS-reconnect uses the delta from the latest seen
            // event rather than replaying everything since mount (unbounded replay
            // regression introduced by snapshot-cache feature).
            if (msg.type === "session:message") {
              const sm = msg as unknown as { sessionId?: string; logSeq?: number };
              if (sm.sessionId != null && sm.logSeq != null) {
                const entry = chatSubs.get(sm.sessionId);
                if (entry) {
                  const current = entry.sinceSeq ?? 0;
                  if (sm.logSeq > current) {
                    chatSubs.set(sm.sessionId, { ...entry, sinceSeq: sm.logSeq });
                  }
                }
              }
            }
          }
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
        // Re-open JSON chats so the daemon re-subscribes this connection and
        // replays the transcript (chat:replay) after a reconnect.  Use the
        // stored `sinceSeq` so the reconnect only fetches the delta (R2.3).
        for (const [sid, entry] of chatSubs.entries()) {
          socket.send(
            JSON.stringify({
              type: "chat:open",
              sessionId: sid,
              ...(entry.sinceSeq != null ? { sinceSeq: entry.sinceSeq } : {}),
            }),
          );
        }
        // Notify consumers that a fresh handshake landed so they can refetch
        // any server state that might have drifted (persisted caches go stale
        // when the client was offline and another client mutated state).
        emit({ type: "ws:open" });
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

    async addProject(body: AddProjectBody): Promise<AddProjectResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<AddProjectResponse>(res);
    },

    async deleteProject(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async hideProject(id: string): Promise<{ ok: true; project: Project }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      return parseJson<{ ok: true; project: Project }>(res);
    },

    async unhideProject(id: string): Promise<{ ok: true; project: Project }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      });
      return parseJson<{ ok: true; project: Project }>(res);
    },

    async listWorktrees(projectId?: string): Promise<Worktree[]> {
      const root = baseUrl();
      const url = projectId
        ? `${root}/worktrees?${new URLSearchParams({ project: projectId })}`
        : `${root}/worktrees`;
      const res = await apiFetch(url);
      return parseJson<Worktree[]>(res);
    },

    async listProjectBranches(projectId: string): Promise<ProjectBranchesResponse> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/projects/${encodeURIComponent(projectId)}/branches`,
      );
      return parseJson<ProjectBranchesResponse>(res);
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
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true }>(res);
    },

    async getDiskUsage(): Promise<DiskUsageResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/disk-usage`);
      return parseJson<DiskUsageResponse>(res);
    },

    /**
     * Mark every agent session in a worktree done and RELEASE the worktree's
     * runtime resources: agent panes/processes are killed, terminals are killed
     * and marked exited. Nothing on disk is removed — each session resumes via
     * `resumeSession` (or, for Rich Chat, by sending a message).
     */
    async markWorktreeDone(
      id: string,
    ): Promise<{ ok: true; updated: number; terminalsReleased: number }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/done`, {
        method: "POST",
      });
      return parseJson<{ ok: true; updated: number; terminalsReleased: number }>(res);
    },

    async pinWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      return parseJson<{ ok: true; worktree: Worktree }>(res);
    },

    async unpinWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
      return parseJson<{ ok: true; worktree: Worktree }>(res);
    },

    async hideWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/hide`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      return parseJson<{ ok: true; worktree: Worktree }>(res);
    },

    async unhideWorktree(id: string): Promise<{ ok: true; worktree: Worktree }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/hide`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      });
      return parseJson<{ ok: true; worktree: Worktree }>(res);
    },

    /** Cosmetic rename (F2). Empty string clears back to the default (falls back to `branch`). */
    async renameWorktree(id: string, name: string): Promise<{ ok: true; name: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return parseJson<{ ok: true; name: string | null }>(res);
    },

    /** Persist a new fractional display-order rank (F9). */
    async reorderWorktree(id: string, sortOrder: number): Promise<{ ok: true; sortOrder: number }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(id)}/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder }),
      });
      return parseJson<{ ok: true; sortOrder: number }>(res);
    },

    /** Daemon-persisted ordered id list for a given scope (pinned-order-sync). */
    async getOrderedList(scopeKey: string): Promise<{ scopeKey: string; itemIds: string[]; updatedAt: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/user/ordered-lists/${encodeURIComponent(scopeKey)}`);
      return parseJson<{ scopeKey: string; itemIds: string[]; updatedAt: string | null }>(res);
    },

    /** Persist the full ordered id list for a given scope (pinned-order-sync). */
    async setOrderedList(
      scopeKey: string,
      itemIds: string[],
    ): Promise<{ ok: true; scopeKey: string; itemIds: string[]; updatedAt: string }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/user/ordered-lists/${encodeURIComponent(scopeKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
      return parseJson<{ ok: true; scopeKey: string; itemIds: string[]; updatedAt: string }>(res);
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

    /** Create a direct session (no worktree) in a project directory. */
    async createDirectSession(body: CreateDirectSessionBody): Promise<Session> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<Session>(res);
    },

    /** Default name the next terminal in this worktree would get ("Terminal N"). */
    async nextTerminalName(worktreeId: string): Promise<string> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(worktreeId)}/next-terminal-name`);
      const { name } = await parseJson<{ name: string }>(res);
      return name;
    },

    /** Pin/unpin a session (toggles pinnedAt). Works for direct + worktree sessions. */
    async pinSession(id: string, pinned: boolean): Promise<{ ok: true; pinnedAt: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      return parseJson<{ ok: true; pinnedAt: string | null }>(res);
    },

    /** Cosmetic rename. Empty string clears back to the computed default label. */
    async renameSession(id: string, name: string): Promise<{ ok: true; name: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return parseJson<{ ok: true; name: string | null }>(res);
    },

    /** Persist a new fractional display-order rank within the session's scope. */
    async reorderSession(id: string, sortOrder: number): Promise<{ ok: true; sortOrder: number }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder }),
      });
      return parseJson<{ ok: true; sortOrder: number }>(res);
    },

    /** Archive the current session and spawn a fresh one in its place. */
    async resetSession(
      id: string,
      body?: { handoff?: boolean; prompt?: string },
    ): Promise<{ ok: true; archivedSessionId: string; newSessionId: string }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return parseJson<{ ok: true; archivedSessionId: string; newSessionId: string }>(res);
    },

    /** Run a standalone handoff turn without archiving/respawning the session. */
    async handoffSession(id: string): Promise<{ ok: true; handoffSummary: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/handoff`, {
        method: "POST",
      });
      return parseJson<{ ok: true; handoffSummary: string | null }>(res);
    },

    /**
     * Mark an agent session done: the daemon kills its tmux pane / pty child and
     * releases its Rich Chat session. The session record, its history and any
     * staged attachments survive, so `resumeSession` brings it back.
     */
    async markSessionDone(id: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(id)}/done`, {
        method: "POST",
      });
      return parseJson<{ ok: true }>(res);
    },

    async terminateSession(id: string): Promise<{ ok: true }> {
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


    async getFileBlob(worktreeId: string, filePath: string, scope: FileScope = "worktree"): Promise<Blob> {
      const path = filePath.replace(/^\/+/, "");
      const res = await apiFetch(`${fileBase(scope, worktreeId)}/files/${path}`);
      if (!res.ok) throw new ApiError("Failed to fetch file", res.status);
      return res.blob();
    },

    async getFile(worktreeId: string, filePath: string, scope: FileScope = "worktree"): Promise<string> {
      const path = filePath.replace(/^\/+/, "");
      const res = await apiFetch(`${fileBase(scope, worktreeId)}/files/${path}`);
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

    async tree(worktreeId: string, path: string, scope: FileScope = "worktree"): Promise<TreeEntry[]> {
      const q = new URLSearchParams({ path: path.replace(/^\/+/, "") });
      const res = await apiFetch(`${fileBase(scope, worktreeId)}/tree?${q}`);
      return parseJson<TreeEntry[]>(res);
    },

    /**
     * Flat list of every file path in the worktree, for Quick Open fuzzy
     * search. Cheap to call once per worktree (~50-100 ms on most repos);
     * the caller should cache and invalidate on `tree:changed`.
     *
     * Accepts an optional `AbortSignal` so callers can cancel the in-flight
     * request — important under React 18 strict mode where effects double-
     * invoke (without abort we'd fire two HTTP requests on every mount).
     */
    async fileList(
      worktreeId: string,
      signal?: AbortSignal,
      scope: FileScope = "worktree",
    ): Promise<{ files: string[]; truncated: boolean; source: "ripgrep" | "node" }> {
      const res = await apiFetch(`${fileBase(scope, worktreeId)}/file-list`, { signal });
      return parseJson<{ files: string[]; truncated: boolean; source: "ripgrep" | "node" }>(res);
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

    /** Commit history for the worktree, most-recent-first, with per-commit diffstat. */
    async listCommits(worktreeId: string, limit = 200): Promise<CommitLogEntry[]> {
      const root = baseUrl();
      const q = new URLSearchParams({ limit: String(limit) });
      const res = await apiFetch(
        `${root}/worktrees/${encodeURIComponent(worktreeId)}/commits?${q}`,
      );
      const { commits } = await parseJson<{ commits: CommitLogEntry[] }>(res);
      return commits;
    },

    /** Best-effort GitHub PR lookup for the worktree's branch; null if there
     *  is none, the remote isn't GitHub, or the lookup couldn't be checked
     *  (transient failure, no credentials) — switches on `kind` rather than
     *  blindly casting the response, so a shape change here fails loudly
     *  instead of silently blanking the PR banner. */
    async getPr(worktreeId: string): Promise<PrInfo | null> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(worktreeId)}/pr`);
      const result = await parseJson<PrLookupResult>(res);
      return result.kind === "pr" ? result.pr : null;
    },

    /** Top-level `.gitmodules` submodules for the worktree, for the VCS tool
     *  tab's "Submodules" section. */
    async listSubmodules(worktreeId: string): Promise<SubmoduleInfo[]> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/worktrees/${encodeURIComponent(worktreeId)}/submodules`);
      const { submodules } = await parseJson<{ submodules: SubmoduleInfo[] }>(res);
      return submodules;
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

    async deleteMode(id: string): Promise<{ ok: true; affectedSessions: number }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/modes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return parseJson<{ ok: true; affectedSessions: number }>(res);
    },

    // ── Settings ────────────────────────────────────────────────────────────────

    async getSettings(): Promise<Settings> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/settings`);
      return parseJson<Settings>(res);
    },

    async updateSettings(body: Partial<Settings>): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<{ ok: true }>(res);
    },

    // ── Create Project ──────────────────────────────────────────────────────────

    async createProject(body: CreateProjectBody): Promise<CreateProjectResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/projects/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<CreateProjectResponse>(res);
    },

    // ── Filesystem autocomplete ─────────────────────────────────────────────────

    async fsComplete(path: string): Promise<FsCompleteResponse> {
      const root = baseUrl();
      const q = new URLSearchParams({ path });
      const res = await apiFetch(`${root}/fs/complete?${q}`);
      return parseJson<FsCompleteResponse>(res);
    },

    async checkFsPath(path: string): Promise<FsCheckResponse> {
      const root = baseUrl();
      const q = new URLSearchParams({ path });
      const res = await apiFetch(`${root}/fs/check?${q}`);
      return parseJson<FsCheckResponse>(res);
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

    // Diagnostic channel (mobile double-text investigation): ship batched input/
    // composition events to the daemon's input-debug log. Best-effort — never
    // throw into the caller (the terminal hot path).
    async sendDebug(entries: Record<string, unknown>[]): Promise<void> {
      try {
        await sendWs({ type: "debug:log", entries });
      } catch {
        /* ignore */
      }
    },

    async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
      await sendWs({ type: "session:resize", sessionId, cols, rows });
    },

    // ── JSON agent chat ─────────────────────────────────────────────────────────

    /** Subscribe to a JSON session's normalized event stream. The daemon replies
     *  with `chat:replay` (bounded tail-N turns) then live `session:message`/
     *  `session:meta`. Pass `sinceSeq` on reconnect to replay only the delta of
     *  events newer than that `logSeq` instead of a fresh tail snapshot (R2.3).
     *
     *  Refcounted: multiple callers may open the same sessionId; chat:open is
     *  only sent to the daemon on the first (0→1) open. */
    async openChat(sessionId: string, sinceSeq?: number): Promise<void> {
      const entry = chatSubs.get(sessionId);
      const prev = entry?.refs ?? 0;
      if (prev === 0) {
        // First subscriber: store sinceSeq for WS-reconnect replays.
        chatSubs.set(sessionId, { refs: 1, sinceSeq });
        await sendWs({ type: "chat:open", sessionId, ...(sinceSeq != null ? { sinceSeq } : {}) });
      } else {
        // Subsequent subscriber: increment ref-count, preserve stored sinceSeq.
        chatSubs.set(sessionId, { refs: prev + 1, sinceSeq: entry?.sinceSeq });
      }
    },

    /** Refcounted close: chat:close is only sent to the daemon when the last
     *  subscriber closes (count drops to 0). Guards against going negative. */
    async closeChat(sessionId: string): Promise<void> {
      const entry = chatSubs.get(sessionId);
      const prev = entry?.refs ?? 0;
      if (prev <= 0) {
        console.warn(`[client] closeChat called with no open subscription for ${sessionId}`);
        chatSubs.delete(sessionId);
        return;
      }
      const next = prev - 1;
      if (next === 0) {
        chatSubs.delete(sessionId);
        await sendWs({ type: "chat:close", sessionId });
      } else {
        chatSubs.set(sessionId, { refs: next, sinceSeq: entry?.sinceSeq });
      }
    },

    /** Enqueue a user turn. Always accepted (202) — queued behind a running turn. */
    async sendChat(
      sessionId: string,
      message: string,
      attachmentIds?: string[],
    ): Promise<SendChatResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
      });
      return parseJson<SendChatResponse>(res);
    },

    /** Abort the active turn (keeps queued turns). */
    async stopChat(sessionId: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/chat/stop`, {
        method: "POST",
      });
      return parseJson<{ ok: true }>(res);
    },

    /** Cancel a single not-yet-started queued turn. */
    async cancelQueuedTurn(sessionId: string, turnId: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/chat/queue/${encodeURIComponent(turnId)}`,
        { method: "DELETE" },
      );
      return parseJson<{ ok: true }>(res);
    },

    /** Withdraw a queued turn for editing → returns its raw content + index. */
    async beginEditQueuedTurn(sessionId: string, turnId: string): Promise<BeginEditResponse> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/chat/queue/${encodeURIComponent(turnId)}/edit`,
        { method: "POST" },
      );
      return parseJson<BeginEditResponse>(res);
    },

    /** Re-enqueue a held turn — `edited` overwrites text/attachments, else restores. */
    async resubmitQueuedTurn(
      sessionId: string,
      turnId: string,
      body: { edited: boolean; message?: string; attachmentIds?: string[] },
    ): Promise<{ ok: true; turnId: string }> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/chat/queue/${encodeURIComponent(turnId)}/resubmit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return parseJson<{ ok: true; turnId: string }>(res);
    },

    /** "Send now" — preempt: jump a queued turn to the front AND interrupt the
     *  active turn so it runs next (the interrupted turn is dropped). */
    async promoteQueuedTurn(sessionId: string, turnId: string): Promise<{ ok: true; turnId: string }> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/chat/queue/${encodeURIComponent(turnId)}/promote`,
        { method: "POST" },
      );
      return parseJson<{ ok: true; turnId: string }>(res);
    },

    /** Edit an already-answered turn → fork (P4/R3.1). Truncates the branch after
     *  the turn and re-runs the edited message from that point (claude only). */
    async forkChat(
      sessionId: string,
      turnId: string,
      message: string,
      attachmentIds?: string[],
    ): Promise<{ ok: true; turnId: string }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/chat/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId, message, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
      });
      return parseJson<{ ok: true; turnId: string }>(res);
    },

    /** Live-switch the session's model (status-bar switcher). `null` clears the
     *  override back to the mode default. Applies to the next spawned turn. */
    async setSessionModel(
      sessionId: string,
      model: string | null,
    ): Promise<{ ok: true; model: string | null }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/chat/model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      return parseJson<{ ok: true; model: string | null }>(res);
    },

    /** Live-switch the session's execution channel (JSON↔terminal toggle, P3/R1.2).
     *  Idle-gated: rejects (409) when a turn is active/queued/held for edit; 400
     *  for direct sessions or CLIs without a native-history importer. */
    async setSessionChannel(
      sessionId: string,
      channel: Channel,
    ): Promise<{ ok: true; channel: Channel }> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/channel`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      return parseJson<{ ok: true; channel: Channel }>(res);
    },

    /** Upload files (multipart) → saved under sessionDataDir/uploads, returns Attachment[]. */
    async uploadAttachments(sessionId: string, files: File[]): Promise<UploadAttachmentsResponse> {
      const root = baseUrl();
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      // Do NOT set Content-Type — the browser sets the multipart boundary.
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/attachments`, {
        method: "POST",
        body: form,
      });
      return parseJson<UploadAttachmentsResponse>(res);
    },

    /**
     * Remove a staged-but-not-yet-consumed attachment (json-mode-followups item
     * 3, Decision 8). Terminal-mode uploads are "live" the moment the daemon
     * writes the pending-uploads reference, so removal needs a real server-side
     * delete — unlike JSON-mode's composer, which drops an unsent draft locally.
     */
    async deleteAttachment(sessionId: string, uploadId: string): Promise<{ ok: true }> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(uploadId)}`,
        { method: "DELETE" },
      );
      return parseJson<{ ok: true }>(res);
    },

    /** Full normalized transcript (replay fallback when WS is unavailable). */
    async getTranscript(sessionId: string): Promise<TranscriptResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/transcript`);
      return parseJson<TranscriptResponse>(res);
    },

    /** Keyset "load earlier" page — events before `beforeSeq`, turn-aligned (R2.2). */
    async getTranscriptPage(
      sessionId: string,
      beforeSeq: number,
      limit = 20,
    ): Promise<TranscriptPage> {
      const root = baseUrl();
      const res = await apiFetch(
        `${root}/sessions/${encodeURIComponent(sessionId)}/transcript?beforeSeq=${beforeSeq}&limit=${limit}`,
      );
      return parseJson<TranscriptPage>(res);
    },

    /** Whole transcript for the guarded "load all" escape hatch (R2.5). */
    async getTranscriptAll(sessionId: string): Promise<TranscriptResponse> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/transcript?all=1`);
      return parseJson<TranscriptResponse>(res);
    },

    /** Latest cross-harness meta (usage/model/turn-state). */
    async getMeta(sessionId: string): Promise<SessionMeta> {
      const root = baseUrl();
      const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/meta`);
      return parseJson<SessionMeta>(res);
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
