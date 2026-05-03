import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiffScope, Session, SessionState } from "@/api/types";

export type TerminalPosition = "left" | "bottom";

/** Indices match ao-142: 0 = file tree, 1 = preview, 2 = terminal — true = hidden */
export type PaneCollapsed = [boolean, boolean, boolean];

export interface WorktreeLayout {
  terminalPosition: TerminalPosition;
  paneCollapsed: PaneCollapsed;
}

export const DEFAULT_WORKTREE_LAYOUT: WorktreeLayout = {
  terminalPosition: "left",
  paneCollapsed: [true, true, false],
};

export interface WorkspaceState {
  /** Per-worktree layout state (terminalPosition + paneCollapsed). Falls back to DEFAULT_WORKTREE_LAYOUT. */
  layoutByWorktree: Record<string, WorktreeLayout>;
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  activeSessionId: string | null;
  activeFilePath: string | null;
  showDotFiles: boolean;
  /** Live session.state mirror for WS + list payloads */
  sessionStates: Record<string, SessionState>;
  /** Last selected tab per worktree (persisted) */
  lastSessionByWorktree: Record<string, string>;
  diffScopeByWorktree: Record<string, DiffScope>;
  previewFontScale: number;
  terminalFontScale: number;
  leftSidebarCollapsed: boolean;
  /** Hide worktrees whose sessions are all done or exited */
  hideInactiveWorktrees: boolean;
  mobileSidebarOpen: boolean;
  /** Transient attach state between openSession and session:opened */
  sessionAttachState: Record<string, "pending" | "attached">;
  setTerminalPosition: (p: TerminalPosition) => void;
  toggleTerminalPosition: () => void;
  /** File tree pane — same as ao-142 index 0 */
  toggleSidebar: () => void;
  togglePaneCollapsed: (index: 0 | 1 | 2) => void;
  /** Expand pane if hidden (e.g. quick-open file selects preview) */
  ensurePaneVisible: (index: 0 | 1 | 2) => void;
  setActiveWorktree: (projectId: string, worktreeId: string, sessions?: Session[]) => void;
  setActiveSession: (sessionId: string) => void;
  setActiveFile: (path: string | null) => void;
  setDiffScopeForWorktree: (worktreeId: string, scope: DiffScope) => void;
  bumpPreviewFont: (delta: number) => void;
  bumpTerminalFont: (delta: number) => void;
  toggleLeftSidebarCollapsed: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleInactiveWorktreesFilter: () => void;
  clearWorkspaceSelection: () => void;
  toggleDotFiles: () => void;
  patchSessionState: (sessionId: string, state: SessionState) => void;
  syncSessionsFromApi: (sessions: Session[]) => void;
  markSessionAttachPending: (sessionId: string) => void;
  markSessionAttached: (sessionId: string) => void;
  clearSessionAttach: (sessionId: string) => void;
}

function tryTogglePane(c: PaneCollapsed, index: 0 | 1 | 2): PaneCollapsed | null {
  const next = [...c] as PaneCollapsed;
  const nextCollapsed = !next[index];
  if (nextCollapsed) {
    const othersStillVisible = [0, 1, 2].filter((j) => j !== index && !next[j]).length;
    if (othersStillVisible === 0) return null;
  }
  next[index] = nextCollapsed;
  return next;
}

const initial = {
  layoutByWorktree: {} as Record<string, WorktreeLayout>,
  activeProjectId: null as string | null,
  activeWorktreeId: null as string | null,
  activeSessionId: null as string | null,
  activeFilePath: null as string | null,
  showDotFiles: true,
  sessionStates: {} as Record<string, SessionState>,
  lastSessionByWorktree: {} as Record<string, string>,
  diffScopeByWorktree: {} as Record<string, DiffScope>,
  previewFontScale: 1,
  terminalFontScale: 1,
  leftSidebarCollapsed: false,
  hideInactiveWorktrees: false,
  mobileSidebarOpen: false,
  sessionAttachState: {} as Record<string, "pending" | "attached">,
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      ...initial,
      setTerminalPosition: (p) =>
        set((s) => {
          if (!s.activeWorktreeId) return s;
          const cur = s.layoutByWorktree[s.activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
          return { layoutByWorktree: { ...s.layoutByWorktree, [s.activeWorktreeId]: { ...cur, terminalPosition: p } } };
        }),
      toggleTerminalPosition: () =>
        set((s) => {
          if (!s.activeWorktreeId) return s;
          const cur = s.layoutByWorktree[s.activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
          const next = cur.terminalPosition === "left" ? "bottom" : "left";
          return { layoutByWorktree: { ...s.layoutByWorktree, [s.activeWorktreeId]: { ...cur, terminalPosition: next } } };
        }),
      toggleSidebar: () =>
        set((s) => {
          if (!s.activeWorktreeId) return s;
          const cur = s.layoutByWorktree[s.activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
          const n = tryTogglePane(cur.paneCollapsed, 0);
          if (!n) return s;
          return { layoutByWorktree: { ...s.layoutByWorktree, [s.activeWorktreeId]: { ...cur, paneCollapsed: n } } };
        }),
      togglePaneCollapsed: (index) =>
        set((s) => {
          if (!s.activeWorktreeId) return s;
          const cur = s.layoutByWorktree[s.activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
          const n = tryTogglePane(cur.paneCollapsed, index);
          if (!n) return s;
          return { layoutByWorktree: { ...s.layoutByWorktree, [s.activeWorktreeId]: { ...cur, paneCollapsed: n } } };
        }),
      ensurePaneVisible: (index) =>
        set((s) => {
          if (!s.activeWorktreeId) return s;
          const cur = s.layoutByWorktree[s.activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
          if (!cur.paneCollapsed[index]) return s;
          const c = [...cur.paneCollapsed] as PaneCollapsed;
          c[index] = false;
          return { layoutByWorktree: { ...s.layoutByWorktree, [s.activeWorktreeId]: { ...cur, paneCollapsed: c } } };
        }),
      setActiveWorktree: (projectId, worktreeId, sessions) =>
        set((s) => {
          // Idempotency: if re-tapping the same worktree with an active session, no-op
          if (worktreeId === s.activeWorktreeId && s.activeSessionId != null) {
            return s;
          }

          // Compute default session: lastSessionByWorktree → main slot → first → null
          let defaultSessionId: string | null = null;
          const lastInWorktree = s.lastSessionByWorktree[worktreeId];
          if (lastInWorktree && sessions?.some((ss) => ss.id === lastInWorktree)) {
            defaultSessionId = lastInWorktree;
          } else if (sessions) {
            const mainSlot = sessions.find((ss) => ss.slot === "m");
            defaultSessionId = mainSlot?.id ?? sessions[0]?.id ?? null;
          }

          return {
            activeProjectId: projectId,
            activeWorktreeId: worktreeId,
            activeSessionId: defaultSessionId,
            activeFilePath: null,
          };
        }),
      setActiveSession: (sessionId) =>
        set((s) => {
          const wt = s.activeWorktreeId;
          const nextLast =
            wt != null
              ? { ...s.lastSessionByWorktree, [wt]: sessionId }
              : s.lastSessionByWorktree;
          return { activeSessionId: sessionId, lastSessionByWorktree: nextLast };
        }),
      setActiveFile: (path) => set({ activeFilePath: path }),
      setDiffScopeForWorktree: (worktreeId, scope) =>
        set((s) => ({
          diffScopeByWorktree: { ...s.diffScopeByWorktree, [worktreeId]: scope },
        })),
      bumpPreviewFont: (delta) =>
        set((s) => ({
          previewFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.previewFontScale + delta) * 100) / 100)),
        })),
      bumpTerminalFont: (delta) =>
        set((s) => ({
          terminalFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.terminalFontScale + delta) * 100) / 100)),
        })),
      toggleLeftSidebarCollapsed: () =>
        set((s) => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      toggleInactiveWorktreesFilter: () =>
        set((s) => ({ hideInactiveWorktrees: !s.hideInactiveWorktrees })),
      clearWorkspaceSelection: () =>
        set({
          activeProjectId: null,
          activeWorktreeId: null,
          activeSessionId: null,
          activeFilePath: null,
        }),
      toggleDotFiles: () => set((s) => ({ showDotFiles: !s.showDotFiles })),
      patchSessionState: (sessionId, state) =>
        set((s) => ({
          sessionStates: { ...s.sessionStates, [sessionId]: state },
        })),
      syncSessionsFromApi: (sessions) =>
        set((s) => {
          const next = { ...s.sessionStates };
          for (const sess of sessions) {
            next[sess.id] = sess.state;
          }
          return { sessionStates: next };
        }),
      markSessionAttachPending: (sessionId) =>
        set((s) => ({
          sessionAttachState: { ...s.sessionAttachState, [sessionId]: "pending" },
        })),
      markSessionAttached: (sessionId) =>
        set((s) => ({
          sessionAttachState: { ...s.sessionAttachState, [sessionId]: "attached" },
        })),
      clearSessionAttach: (sessionId) =>
        set((s) => {
          const next = { ...s.sessionAttachState };
          delete next[sessionId];
          return { sessionAttachState: next };
        }),
    }),
    {
      name: "viberun:workspace",
      version: 3,
      migrate: (persisted) => {
        const p = persisted as Record<string, unknown> | null;
        if (!p || typeof p !== "object") return persisted;
        // v1/v2 → v3: move global terminalPosition+paneCollapsed into layoutByWorktree
        if (!p.layoutByWorktree) {
          return { ...p, layoutByWorktree: {} };
        }
        return persisted;
      },
      partialize: (s) => ({
        layoutByWorktree: s.layoutByWorktree,
        activeProjectId: s.activeProjectId,
        activeWorktreeId: s.activeWorktreeId,
        activeSessionId: s.activeSessionId,
        showDotFiles: s.showDotFiles,
        sessionStates: s.sessionStates,
        lastSessionByWorktree: s.lastSessionByWorktree,
        diffScopeByWorktree: s.diffScopeByWorktree,
        previewFontScale: s.previewFontScale,
        terminalFontScale: s.terminalFontScale,
        leftSidebarCollapsed: s.leftSidebarCollapsed,
        hideInactiveWorktrees: s.hideInactiveWorktrees,
      }),
    },
  ),
);
