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

  // Bulk replace — initial load and ws:open refetch.
  replaceAll: (data: { projects: Project[]; worktrees: Worktree[]; sessions: Session[] }) => void;

  // Targeted patches driven by WS events. Cheaper than refetching the world
  // for a single state transition.
  applyProjectCreated: (p: Project) => void;
  applyProjectDeleted: (projectId: string) => void;
  applyWorktreeCreated: (w: Worktree) => void;
  applyWorktreeDeleted: (worktreeId: string) => void;
  applySessionCreated: (s: Session) => void;
  applySessionUpdated: (sessionId: string, patch: Partial<Session>) => void;
  applySessionDeleted: (sessionId: string) => void;
}

export const useServerStore = create<ServerData>((set) => ({
  projects: [],
  worktrees: [],
  sessions: [],
  loaded: false,

  replaceAll: ({ projects, worktrees, sessions }) =>
    set({ projects, worktrees, sessions, loaded: true }),

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

  applyWorktreeCreated: (w) =>
    set((s) =>
      s.worktrees.some((x) => x.id === w.id) ? s : { worktrees: [...s.worktrees, w] },
    ),

  applyWorktreeDeleted: (worktreeId) =>
    set((s) => ({
      worktrees: s.worktrees.filter((w) => w.id !== worktreeId),
      sessions: s.sessions.filter((sess) => sess.worktreeId !== worktreeId),
    })),

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
