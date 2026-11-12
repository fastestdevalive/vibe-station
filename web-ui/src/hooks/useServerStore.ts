import { create } from "zustand";
import type { AccountLimited, AccountSummary, DiffStatEntry, Project, Session, Worktree } from "@/api/types";

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
  /** Accounts of every CLI that supports them, System rows included — one
   *  source of truth for Settings, the draft picker, badges and banners. */
  accounts: AccountSummary[];
  /** Flips to true after the first `GET /accounts` resolves. */
  accountsLoaded: boolean;

  // Bulk replace — initial load and ws:open refetch.
  replaceAll: (data: { projects: Project[]; worktrees: Worktree[]; sessions: Session[] }) => void;

  // Accounts: bulk replace on load/reconnect, upserts for WS events.
  replaceAccounts: (accounts: AccountSummary[]) => void;
  applyAccountUpdated: (acct: AccountSummary) => void;
  applyAccountRemoved: (cli: string, accountId: string) => void;
  /** Patches ONLY `limited` (`accountId` null = the CLI's System login). */
  applyAccountLimited: (cli: string, accountId: string | null, limited: AccountLimited | null) => void;

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

/** Compare two `limited` values so a redundant `account:limited` broadcast
 *  doesn't re-render every account consumer. */
function sameLimited(a: AccountLimited | null, b: AccountLimited | null): boolean {
  if (a === null || b === null) return a === b;
  return a.windowId === b.windowId && a.resetsAt === b.resetsAt && a.source === b.source;
}

export const useServerStore = create<ServerData>((set) => ({
  projects: [],
  worktrees: [],
  sessions: [],
  diffStats: {},
  loaded: false,
  accounts: [],
  accountsLoaded: false,

  replaceAll: ({ projects, worktrees, sessions }) =>
    set({ projects, worktrees, sessions, loaded: true }),

  replaceAccounts: (accounts) => set({ accounts, accountsLoaded: true }),

  applyAccountUpdated: (acct) =>
    set((s) => {
      const idx = s.accounts.findIndex((a) => a.cli === acct.cli && a.id === acct.id);
      if (idx === -1) return { accounts: [...s.accounts, acct] };
      const next = s.accounts.slice();
      next[idx] = acct;
      return { accounts: next };
    }),

  applyAccountRemoved: (cli, accountId) =>
    set((s) => ({
      accounts: s.accounts.filter((a) => !(a.cli === cli && a.id === accountId)),
    })),

  applyAccountLimited: (cli, accountId, limited) =>
    set((s) => {
      // A `null` accountId on the wire means the CLI's System row.
      const id = accountId ?? "system";
      const idx = s.accounts.findIndex((a) => a.cli === cli && a.id === id);
      const current = s.accounts[idx];
      if (!current || sameLimited(current.limited, limited)) return s;
      const next = s.accounts.slice();
      next[idx] = { ...current, limited };
      return { accounts: next };
    }),

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
