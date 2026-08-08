import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiffScope, Session, SessionState } from "@/api/types";

/** Tools hosted by the right-side tool panel (one visible at a time). */
export type ToolTab = "files" | "devices" | "artifacts";

export const TOOL_TABS: ToolTab[] = ["files", "devices", "artifacts"];

/**
 * Per-worktree workspace layout.
 *
 * The IDE has three regions: the agent pane (center, always present), the
 * right-side tool panel (Files/Devices/Artifacts — one tool visible at a time),
 * and the bottom terminal dock (terminal sessions). The agent pane is never
 * collapsed; the tool panel and terminal dock are. The Files tool is
 * master-detail (tree + preview); Devices hosts the web browser +
 * emulators/devices as sub-tabs; Artifacts is master-detail (list + preview).
 */
/** Agent pane ↔ tool panel split orientation (terminal dock stays at the bottom). */
export type ToolSplitOrientation = "horizontal" | "vertical";

export interface WorktreeLayout {
  toolPanelVisible: boolean;
  toolPanelTab: ToolTab;
  terminalDockVisible: boolean;
  /** "horizontal" = agent | tools side by side; "vertical" = agent / tools stacked. */
  toolSplitOrientation: ToolSplitOrientation;
}

export const DEFAULT_WORKTREE_LAYOUT: WorktreeLayout = {
  toolPanelVisible: true,
  toolPanelTab: "files",
  terminalDockVisible: false,
  toolSplitOrientation: "horizontal",
};

/** IDE viewport fullscreen for the agent pane, tool panel, or terminal dock (not persisted). */
export type WorkspacePaneFullscreen = "agent" | "tools" | "terminal";

/** Draggable-resize bounds for the desktop left sidebar (px). */
export const LEFT_SIDEBAR_MIN_WIDTH = 180;
export const LEFT_SIDEBAR_MAX_WIDTH = 480;

function clampLeftSidebarWidth(px: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.round(px)));
}

export interface WorkspaceState {
  /** Per-worktree layout state. Falls back to DEFAULT_WORKTREE_LAYOUT. */
  layoutByWorktree: Record<string, WorktreeLayout>;
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  /**
   * Layout context for a direct session (no worktree): the project id. Direct
   * sessions reuse the per-context layout map keyed by this id, so tool-panel /
   * terminal-dock toggles work just like a worktree. Null outside direct sessions.
   */
  activeDirectContextId: string | null;
  /** Active *agent* session (drives the agent pane + file preview). */
  activeSessionId: string | null;
  /** Active *terminal* session shown in the bottom terminal dock. */
  activeTerminalSessionId: string | null;
  activeFilePath: string | null;
  /** Last opened file path per worktree (persisted). */
  lastFileByWorktree: Record<string, string>;
  /** Preview scroll position keyed by `${worktreeId}:${filePath}` (persisted). */
  fileScrollByKey: Record<string, number>;
  showDotFiles: boolean;
  /** Live session.state mirror for WS + list payloads */
  sessionStates: Record<string, SessionState>;
  /** Last selected agent tab per worktree (persisted) */
  lastSessionByWorktree: Record<string, string>;
  /** Last selected terminal tab per worktree (persisted) */
  lastTerminalByWorktree: Record<string, string>;
  diffScopeByWorktree: Record<string, DiffScope>;
  previewFontScale: number;
  /** Whether the Files tool shows its file-tree column (persisted, view pref). */
  fileTreeVisible: boolean;
  terminalFontScale: number;
  leftSidebarCollapsed: boolean;
  /** Desktop left sidebar width in px when expanded (persisted, drag-resizable). */
  leftSidebarWidthPx: number;
  /** Hide worktrees whose agent sessions are all explicitly marked done (not exited) */
  hideInactiveWorktrees: boolean;
  mobileSidebarOpen: boolean;
  /** Transient attach state between openSession and session:opened */
  sessionAttachState: Record<string, "pending" | "attached">;
  /** A region maximized over the full viewport (sidebar + top bar area). */
  workspacePaneFullscreen: WorkspacePaneFullscreen | null;
  setWorkspacePaneFullscreen: (next: WorkspacePaneFullscreen | null) => void;
  /** Toggle the right-side tool panel. */
  toggleToolPanel: () => void;
  /** Select a tool tab, making the panel visible. */
  setToolPanelTab: (tab: ToolTab) => void;
  /** Toggle the bottom terminal dock. */
  toggleTerminalDock: () => void;
  /** Flip the agent pane ↔ tool panel split between horizontal and vertical. */
  toggleToolSplitOrientation: () => void;
  setActiveWorktree: (projectId: string, worktreeId: string, sessions?: Session[]) => void;
  /** Set (or clear with null) the direct-session layout context (project id). */
  setActiveDirectContext: (projectId: string | null) => void;
  setActiveSession: (sessionId: string) => void;
  setActiveTerminalSession: (sessionId: string) => void;
  setActiveFile: (path: string | null) => void;
  setFileScroll: (worktreeId: string, filePath: string, scrollTop: number) => void;
  setDiffScopeForWorktree: (worktreeId: string, scope: DiffScope) => void;
  bumpPreviewFont: (delta: number) => void;
  /** Show/hide the Files tool's file-tree column. */
  toggleFileTree: () => void;
  bumpTerminalFont: (delta: number) => void;
  toggleLeftSidebarCollapsed: () => void;
  setLeftSidebarWidthPx: (px: number) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleInactiveWorktreesFilter: () => void;
  clearWorkspaceSelection: () => void;
  toggleDotFiles: () => void;
  patchSessionState: (sessionId: string, state: SessionState) => void;
  syncSessionsFromApi: (sessions: Session[]) => void;
  markSessionAttachPending: (sessionId: string) => void;
  markSessionAttached: (sessionId: string) => void;
  clearSessionAttach: (sessionId: string) => void;

  /**
   * Drag-reorder state: scopeKey -> ordered list of item ids.
   *
   * As of Part 03 Phase 2, regular (unpinned) per-worktree/per-project scopes
   * (`tabs:*`, `worktrees:${projectId}`, `direct:${projectId}`) are ordered by
   * the server's real numeric `sortOrder` column instead — see
   * `computeNewSortOrder` below. This map now ONLY holds the pinned sub-lists,
   * which stay on the old local-only mechanism because the server's
   * `sortOrder` column is scoped per-worktree/per-project and cannot express a
   * cross-project pinned order (see plan Decision 1 exception):
   *   - `pinned-worktrees` / `pinned-direct` — the pinned sub-lists (their own
   *     reorderable scope, independent of pin recency — see LeftSidebar).
   * Missing/unknown ids (id not yet dragged) are appended in their natural
   * order by callers — this map only needs to hold the ids the user has
   * actually dragged. The merge helper for this (formerly `applySortOrder`,
   * exported from here) now lives privately in `LeftSidebar.tsx`, the only
   * remaining consumer, since it's scoped to the pinned sub-lists only.
   */
  sortOrders: Record<string, string[]>;
  setSortOrder: (scopeKey: string, orderedIds: string[]) => void;
}

/**
 * Compute the moved item's new fractional `sortOrder` value from the real
 * `sortOrder` of its new neighbors (server-backed drag-reorder — Decision 1).
 *
 *  - No neighbors at all (only item in the scope) -> 0
 *  - No previous neighbor (now first) -> next - 1
 *  - No next neighbor (now last) -> prev + 1
 *  - Between two neighbors -> their midpoint
 */
export function computeNewSortOrder(
  prevSortOrder: number | undefined,
  nextSortOrder: number | undefined,
): number {
  if (prevSortOrder == null && nextSortOrder == null) return 0; // only item in the scope
  if (prevSortOrder == null) return nextSortOrder! - 1; // now first
  if (nextSortOrder == null) return prevSortOrder + 1; // now last
  return (prevSortOrder + nextSortOrder) / 2; // between two neighbors
}

const initial = {
  layoutByWorktree: {} as Record<string, WorktreeLayout>,
  activeProjectId: null as string | null,
  activeWorktreeId: null as string | null,
  activeDirectContextId: null as string | null,
  activeSessionId: null as string | null,
  activeTerminalSessionId: null as string | null,
  activeFilePath: null as string | null,
  lastFileByWorktree: {} as Record<string, string>,
  fileScrollByKey: {} as Record<string, number>,
  showDotFiles: true,
  sessionStates: {} as Record<string, SessionState>,
  lastSessionByWorktree: {} as Record<string, string>,
  lastTerminalByWorktree: {} as Record<string, string>,
  diffScopeByWorktree: {} as Record<string, DiffScope>,
  previewFontScale: 1,
  fileTreeVisible: true,
  terminalFontScale: 1,
  leftSidebarCollapsed: false,
  leftSidebarWidthPx: 220,
  hideInactiveWorktrees: true,
  mobileSidebarOpen: false,
  sessionAttachState: {} as Record<string, "pending" | "attached">,
  workspacePaneFullscreen: null as WorkspacePaneFullscreen | null,
  sortOrders: {} as Record<string, string[]>,
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => {
      /** Active layout key: worktree id, or the direct-session project id. */
      function layoutKey(s: WorkspaceState): string | null {
        return s.activeWorktreeId ?? s.activeDirectContextId;
      }

      /** Patch the active context's layout, falling back to defaults. */
      function patchLayout(
        s: WorkspaceState,
        patch: Partial<WorktreeLayout>,
      ): Partial<WorkspaceState> {
        const key = layoutKey(s);
        if (!key) return s;
        const cur = s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT;
        return {
          layoutByWorktree: {
            ...s.layoutByWorktree,
            [key]: { ...cur, ...patch },
          },
        };
      }

      return {
        ...initial,
        toggleToolPanel: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = patchLayout(s, { toolPanelVisible: !cur.toolPanelVisible });
            // Leaving fullscreen if we just hid the panel that was maximized.
            if (cur.toolPanelVisible && s.workspacePaneFullscreen === "tools") {
              return { ...next, workspacePaneFullscreen: null };
            }
            return next;
          }),
        setToolPanelTab: (tab) =>
          set((s) => patchLayout(s, { toolPanelTab: tab, toolPanelVisible: true })),
        toggleTerminalDock: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = patchLayout(s, { terminalDockVisible: !cur.terminalDockVisible });
            if (cur.terminalDockVisible && s.workspacePaneFullscreen === "terminal") {
              return { ...next, workspacePaneFullscreen: null };
            }
            return next;
          }),
        toggleToolSplitOrientation: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = cur.toolSplitOrientation === "horizontal" ? "vertical" : "horizontal";
            return patchLayout(s, { toolSplitOrientation: next });
          }),
        setActiveWorktree: (projectId, worktreeId, sessions) =>
          set((s) => {
            // Idempotency: if re-tapping the same worktree with an active session, no-op
            if (worktreeId === s.activeWorktreeId && s.activeSessionId != null) {
              return s;
            }

            // Compute default agent session: lastSessionByWorktree → main slot → first agent → null
            let defaultSessionId: string | null = null;
            const lastInWorktree = s.lastSessionByWorktree[worktreeId];
            const agents = sessions?.filter((ss) => ss.type === "agent");
            if (lastInWorktree && agents?.some((ss) => ss.id === lastInWorktree)) {
              defaultSessionId = lastInWorktree;
            } else if (agents) {
              const mainSlot = agents.find((ss) => ss.isMain);
              defaultSessionId = mainSlot?.id ?? agents[0]?.id ?? null;
            }

            // Compute default terminal session: lastTerminalByWorktree → first terminal → null
            let defaultTerminalId: string | null = null;
            const terminals = sessions?.filter((ss) => ss.type === "terminal");
            const lastTerm = s.lastTerminalByWorktree[worktreeId];
            if (lastTerm && terminals?.some((ss) => ss.id === lastTerm)) {
              defaultTerminalId = lastTerm;
            } else if (terminals) {
              defaultTerminalId = terminals[0]?.id ?? null;
            }

            return {
              activeProjectId: projectId,
              activeWorktreeId: worktreeId,
              activeSessionId: defaultSessionId,
              activeTerminalSessionId: defaultTerminalId,
              activeFilePath: s.lastFileByWorktree[worktreeId] ?? null,
            };
          }),
        // Restore the last file for this project context, mirroring what
        // setActiveWorktree does for worktrees. Entering a direct session used
        // to leave activeFilePath at whatever the previous context had.
        setActiveDirectContext: (projectId) =>
          set((s) => {
            if (projectId == null) return { activeDirectContextId: null };
            return {
              activeDirectContextId: projectId,
              activeFilePath: s.lastFileByWorktree[projectId] ?? null,
            };
          }),
        setActiveSession: (sessionId) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLast =
              key != null
                ? { ...s.lastSessionByWorktree, [key]: sessionId }
                : s.lastSessionByWorktree;
            return { activeSessionId: sessionId, lastSessionByWorktree: nextLast };
          }),
        setActiveTerminalSession: (sessionId) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLast =
              key != null
                ? { ...s.lastTerminalByWorktree, [key]: sessionId }
                : s.lastTerminalByWorktree;
            return { activeTerminalSessionId: sessionId, lastTerminalByWorktree: nextLast };
          }),
        // Keyed by layoutKey (worktree id, or the direct-session project id) —
        // NOT activeWorktreeId, which is always null for a direct session and
        // so silently dropped their open file from the restore map.
        // setActiveSession/setActiveTerminalSession above already do this.
        setActiveFile: (path) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLastFile =
              path && key != null
                ? { ...s.lastFileByWorktree, [key]: path }
                : s.lastFileByWorktree;
            return { activeFilePath: path, lastFileByWorktree: nextLastFile };
          }),
        setFileScroll: (worktreeId, filePath, scrollTop) =>
          set((s) => ({
            fileScrollByKey: { ...s.fileScrollByKey, [`${worktreeId}:${filePath}`]: scrollTop },
          })),
        setDiffScopeForWorktree: (worktreeId, scope) =>
          set((s) => ({
            diffScopeByWorktree: { ...s.diffScopeByWorktree, [worktreeId]: scope },
          })),
        bumpPreviewFont: (delta) =>
          set((s) => ({
            previewFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.previewFontScale + delta) * 100) / 100)),
          })),
        toggleFileTree: () => set((s) => ({ fileTreeVisible: !s.fileTreeVisible })),
        bumpTerminalFont: (delta) =>
          set((s) => ({
            terminalFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.terminalFontScale + delta) * 100) / 100)),
          })),
        toggleLeftSidebarCollapsed: () =>
          set((s) => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
        setLeftSidebarWidthPx: (px) => set({ leftSidebarWidthPx: clampLeftSidebarWidth(px) }),
        setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
        toggleInactiveWorktreesFilter: () =>
          set((s) => ({ hideInactiveWorktrees: !s.hideInactiveWorktrees })),
        setWorkspacePaneFullscreen: (next) => set({ workspacePaneFullscreen: next }),
        clearWorkspaceSelection: () =>
          set({
            activeProjectId: null,
            activeWorktreeId: null,
            activeDirectContextId: null,
            activeSessionId: null,
            activeTerminalSessionId: null,
            activeFilePath: null,
            workspacePaneFullscreen: null,
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
        setSortOrder: (scopeKey, orderedIds) =>
          set((s) => ({
            sortOrders: { ...s.sortOrders, [scopeKey]: orderedIds },
          })),
      };
    },
    {
      name: "vibestation:workspace",
      version: 12,
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | null;
        if (!p || typeof p !== "object") return persisted;
        // v1/v2 → v3: move global terminalPosition+paneCollapsed into layoutByWorktree
        if (!p.layoutByWorktree) {
          p.layoutByWorktree = {};
        }
        // <v5 → v5: the old per-worktree layout was { terminalPosition, paneCollapsed:
        // [treeHidden, previewHidden, terminalHidden] }. Map it onto the new
        // { toolPanelVisible, toolPanelTab, terminalDockVisible } region model.
        if (version < 5) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as { paneCollapsed?: boolean[] } | undefined;
            const pc = entry?.paneCollapsed ?? [true, true, false];
            const treeVisible = !pc[0];
            const previewVisible = !pc[1];
            const terminalVisible = !pc[2];
            next[wt] = {
              toolPanelVisible: treeVisible || previewVisible,
              toolPanelTab: "files",
              terminalDockVisible: terminalVisible,
              toolSplitOrientation: "horizontal",
            };
          }
          p.layoutByWorktree = next;
          p.lastTerminalByWorktree = {};
        }
        // v6 → v7: the file tree briefly lived in its own pane (fileTreeVisible +
        // a "files"-less ToolTab). It's back as a tool-panel tab — fold the
        // separate-tree state back in: if the tree was open, select the Files tab.
        if (version === 6) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              fileTreeVisible?: boolean;
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const treeWasOpen = entry?.fileTreeVisible ?? true;
            next[wt] = {
              toolPanelVisible: (entry?.toolPanelVisible ?? true) || treeWasOpen,
              toolPanelTab: (treeWasOpen ? "files" : (entry?.toolPanelTab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
            };
          }
          p.layoutByWorktree = next;
        }
        // v7 → v8: the Browser and Emulator tabs merged into a single "devices"
        // tab. Map either legacy tab onto "devices"; other tabs are unchanged.
        if (version < 8) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const tab = entry?.toolPanelTab;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (tab === "browser" || tab === "emulator" ? "devices" : (tab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
            };
          }
          p.layoutByWorktree = next;
        }
        // v8 → v9: Preview merged into the Files tool (master-detail tree +
        // preview). Map a stored "preview" tab onto "files".
        if (version < 9) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const tab = entry?.toolPanelTab;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (tab === "preview" ? "files" : (tab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
            };
          }
          p.layoutByWorktree = next;
        }
        // v9 → v10: add the agent↔tools split orientation (default horizontal).
        if (version < 10) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
            };
          }
          p.layoutByWorktree = next;
        }
        // v10 → v11: "hide done" now defaults ON. Existing browsers persisted the
        // old `false` default, so done worktrees stayed visible on machines other
        // than the one where the filter was toggled. Flip legacy persisted state to
        // the new default so done worktrees hide consistently across clients.
        if (version < 11) {
          p.hideInactiveWorktrees = true;
        }
        return p;
      },
      partialize: (s) => ({
        layoutByWorktree: s.layoutByWorktree,
        activeProjectId: s.activeProjectId,
        activeWorktreeId: s.activeWorktreeId,
        activeSessionId: s.activeSessionId,
        activeTerminalSessionId: s.activeTerminalSessionId,
        activeFilePath: s.activeFilePath,
        lastFileByWorktree: s.lastFileByWorktree,
        fileScrollByKey: s.fileScrollByKey,
        showDotFiles: s.showDotFiles,
        sessionStates: s.sessionStates,
        lastSessionByWorktree: s.lastSessionByWorktree,
        lastTerminalByWorktree: s.lastTerminalByWorktree,
        diffScopeByWorktree: s.diffScopeByWorktree,
        previewFontScale: s.previewFontScale,
        fileTreeVisible: s.fileTreeVisible,
        terminalFontScale: s.terminalFontScale,
        leftSidebarCollapsed: s.leftSidebarCollapsed,
        leftSidebarWidthPx: s.leftSidebarWidthPx,
        hideInactiveWorktrees: s.hideInactiveWorktrees,
        sortOrders: s.sortOrders,
      }),
    },
  ),
);
