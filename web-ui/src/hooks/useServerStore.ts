import { create } from "zustand";
import type { Project, Session, Worktree } from "@/api/types";

/**
 * Server-fetched data: the projects/worktrees/sessions trio that every
 * dashboard and sidebar consumer needs to render. Owned in one place so:
 *   - both DashboardPanel and LeftSidebar read the same truth;
 *   - cold-load + reconnect refetch is wired once (in `useServerSync`), not
 *     duplicated across components with subtly different fallback paths;
 *   - WS event reducers update the store, not local component state, so
 *     components don't drift when only one of them is mounted.
 *
 * Intentionally NOT persisted. This is server truth — always fetch on load.
 * UI state (selections, layout, persisted live session states) stays in
 * `useStore`'s `useWorkspaceStore`.
 */
interface ServerData {
  projects: Project[];
  worktrees: Worktree[];
  sessions: Session[];
  /** Flips to true after the first refresh resolves. UI can render a stable
   *  empty state in the meantime rather than flicker through a half-loaded
   *  view as each list arrives. (We use one Promise.all so in practice all
   *  three land together — `loaded` just makes the boundary explicit.) */
  loaded: boolean;
  /** FIFO child session lists keyed by parentSessionId. Client-only, transient —
   *  not persisted. Populated from the sessions list on every replaceAll (cold
   *  load / reconnect) and extended in FIFO order by live session:created events.
   *  Consumed (front-popped) inside groupEvents to correlate task tool_use entries
   *  with their spawned child sessions. */
  childByParent: Map<string, string[]>;

  // Bulk replace — initial load and ws:open refetch.
  replaceAll: (data: { projects: Project[]; worktrees: Worktree[]; sessions: Session[] }) => void;
  /** Append a childSessionId to the FIFO queue for parentSessionId. Called from
   *  the session:created WS handler when ev.spawnedFrom is set. */
  addChildSession: (parentId: string, childId: string) => void;

  // Targeted patches driven by WS events. Cheaper than refetching the world
  // for a single state transition.
  applyProjectCreated: (p: Project) => void;
  applyProjectDeleted: (projectId: string) => void;
  applyProjectUpdated: (p: Project) => void;
  applyWorktreeCreated: (w: Worktree) => void;
  applyWorktreeDeleted: (worktreeId: string) => void;
  applyWorktreeUpdated: (w: Worktree) => void;
  applySessionCreated: (s: Session) => void;
  applySessionUpdated: (sessionId: string, patch: Partial<Session>) => void;
  applySessionDeleted: (sessionId: string) => void;
}

/** Build childByParent from a sessions array by grouping sessions that have
 *  spawnedFrom set. Used in replaceAll so cold-load and reconnect both produce
 *  a correct initial map without waiting for live session:created events. */
function buildChildByParent(sessions: Session[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.spawnedFrom) {
      const list = map.get(s.spawnedFrom);
      if (list) {
        list.push(s.id);
      } else {
        map.set(s.spawnedFrom, [s.id]);
      }
    }
  }
  return map;
}

export const useServerStore = create<ServerData>((set) => ({
  projects: [],
  worktrees: [],
  sessions: [],
  loaded: false,
  childByParent: new Map(),

  replaceAll: ({ projects, worktrees, sessions }) =>
    set({ projects, worktrees, sessions, loaded: true, childByParent: buildChildByParent(sessions) }),

  addChildSession: (parentId, childId) =>
    set((s) => {
      const existing = s.childByParent.get(parentId);
      if (existing?.includes(childId)) return s;
      const next = new Map(s.childByParent);
      if (existing) {
        next.set(parentId, [...existing, childId]);
      } else {
        next.set(parentId, [childId]);
      }
      return { childByParent: next };
    }),

  applyProjectCreated: (p) =>
    set((s) => (s.projects.some((x) => x.id === p.id) ? s : { projects: [...s.projects, p] })),

  applyProjectDeleted: (projectId) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      // Cascade — worktrees/sessions for a deleted project shouldn't linger.
      worktrees: s.worktrees.filter((w) => w.projectId !== projectId),
      sessions: s.sessions.filter(
        (sess) => !s.worktrees.some((w) => w.projectId === projectId && w.id === sess.worktreeId),
      ),
    })),

  applyProjectUpdated: (p) =>
    set((s) => {
      const idx = s.projects.findIndex((x) => x.id === p.id);
      // Drop silently if we don't know this id — avoids surprise inserts from a
      // server racing ahead of our initial list (mirrors applyWorktreeUpdated).
      if (idx === -1) return s;
      const next = s.projects.slice();
      next[idx] = p;
      return { projects: next };
    }),

  applyWorktreeCreated: (w) =>
    set((s) =>
      s.worktrees.some((x) => x.id === w.id) ? s : { worktrees: [...s.worktrees, w] },
    ),

  applyWorktreeDeleted: (worktreeId) =>
    set((s) => ({
      worktrees: s.worktrees.filter((w) => w.id !== worktreeId),
      sessions: s.sessions.filter((sess) => sess.worktreeId !== worktreeId),
    })),

  applyWorktreeUpdated: (w) =>
    set((s) => {
      const idx = s.worktrees.findIndex((x) => x.id === w.id);
      // Drop silently if we don't know about this id — avoids surprise inserts
      // from a server that's racing ahead of our initial list.
      if (idx === -1) return s;
      const next = s.worktrees.slice();
      next[idx] = w;
      return { worktrees: next };
    }),

  applySessionCreated: (sess) =>
    set((s) => {
      const existing = s.sessions.findIndex((x) => x.id === sess.id);
      if (existing === -1) return { sessions: [...s.sessions, sess] };
      const next = s.sessions.slice();
      next[existing] = sess;
      return { sessions: next };
    }),

  applySessionUpdated: (sessionId, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, ...patch } : x)),
    })),

  applySessionDeleted: (sessionId) =>
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== sessionId) })),
}));
