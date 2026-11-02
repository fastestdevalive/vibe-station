import { create } from "zustand";
import type { DiffStatEntry, Project, Session, Worktree } from "@/api/types";

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
  diffStats: Record<string, DiffStatEntry>;
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
  applyProjectUpdated: (p: Project) => void;
  applyWorktreeCreated: (w: Worktree) => void;
  applyWorktreeDeleted: (worktreeId: string) => void;
  applyWorktreeUpdated: (w: Worktree) => void;
  applySessionCreated: (s: Session) => void;
  applySessionUpdated: (sessionId: string, patch: Partial<Session>) => void;
  applySessionDeleted: (sessionId: string) => void;
  applyWorktreeDiffStat: (worktreeId: string, entry: DiffStatEntry) => void;
  seedDiffStats: (map: Record<string, DiffStatEntry>) => void;
}

export const useServerStore = create<ServerData>((set) => ({
  projects: [],
  worktrees: [],
  sessions: [],
  diffStats: {},
  loaded: false,

  replaceAll: ({ projects, worktrees, sessions }) =>
    set({ projects, worktrees, sessions, loaded: true }),

  applyProjectCreated: (p) =>
    set((s) => (s.projects.some((x) => x.id === p.id) ? s : { projects: [...s.projects, p] })),

  applyProjectDeleted: (projectId) =>
    set((s) => {
      const deletedWtIds = new Set(
        s.worktrees.filter((w) => w.projectId === projectId).map((w) => w.id),
      );
      const remainingDiffStats = Object.fromEntries(
        Object.entries(s.diffStats).filter(([id]) => !deletedWtIds.has(id)),
      );
      return {
        projects: s.projects.filter((p) => p.id !== projectId),
        // Cascade — worktrees/sessions for a deleted project shouldn't linger.
        worktrees: s.worktrees.filter((w) => w.projectId !== projectId),
        sessions: s.sessions.filter(
          (sess) => !s.worktrees.some((w) => w.projectId === projectId && w.id === sess.worktreeId),
        ),
        diffStats: remainingDiffStats,
      };
    }),

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
    set((s) => {
      const { [worktreeId]: _, ...remainingDiffStats } = s.diffStats;
      return {
        worktrees: s.worktrees.filter((w) => w.id !== worktreeId),
        sessions: s.sessions.filter((sess) => sess.worktreeId !== worktreeId),
        diffStats: remainingDiffStats,
      };
    }),

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
      // Merge, don't replace: a `session:created` WS broadcast's snapshot
      // (`SessionCreatedSnapshot`, both daemons) is a fixed, narrower field
      // set than the full `Session` record a draft-creation call site
      // already registered here via its own HTTP response (e.g.
      // `draftConfig` isn't carried on the snapshot at all). Replacing
      // wholesale let a same-id snapshot arriving after the real record —
      // entirely possible once broadcasts are correctly delivered — silently
      // erase fields the snapshot never had an opinion on, which fed
      // `DraftComposer`'s `entryPoint = session?.draftConfig?.entryPoint ??
      // "direct"` fallback and made a worktree-tab draft render as a
      // "direct" one (wrong composer UI, no navigation on submit).
      const next = s.sessions.slice();
      next[existing] = { ...s.sessions[existing], ...sess };
      return { sessions: next };
    }),

  applySessionUpdated: (sessionId, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, ...patch } : x)),
    })),

  applySessionDeleted: (sessionId) =>
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== sessionId) })),

  applyWorktreeDiffStat: (worktreeId, entry) =>
    set((s) => {
      const existing = s.diffStats[worktreeId];
      if (existing && existing.rev >= entry.rev) {
        return s;
      }
      return {
        diffStats: {
          ...s.diffStats,
          [worktreeId]: entry,
        },
      };
    }),

  seedDiffStats: (map) =>
    set((s) => {
      let changed = false;
      const next = { ...s.diffStats };
      for (const [id, entry] of Object.entries(map)) {
        const existing = next[id];
        if (!existing || entry.rev > existing.rev) {
          next[id] = entry;
          changed = true;
        }
      }
      return changed ? { diffStats: next } : s;
    }),
}));
