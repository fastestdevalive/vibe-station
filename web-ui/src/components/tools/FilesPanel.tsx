import { ArrowUpRight, FileText, List, ListTree, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore, type PeekFileValue } from "@/hooks/useStore";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { FilesLeftPane, type FilesLeftPaneHandle } from "@/components/layout/FilesLeftPane";
import { usePendingFileOpens } from "@/hooks/usePendingFileOpens";
import { useToolsInset } from "@/context/ToolsInsetContext";
import {
  FILES_LEFT_PANE_DEFAULT_WIDTH,
  FILES_LEFT_PANE_MIN_WIDTH,
  FILES_LEFT_PANE_MAX_WIDTH,
  FILES_LEFT_PANE_DEFAULT_HEIGHT,
  FILES_LEFT_PANE_MIN_HEIGHT,
  FILES_LEFT_PANE_MAX_HEIGHT,
} from "@/components/layout/ToolPanel";
import { DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

interface FilesPanelProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
  onOpenQuickOpen?: () => void;
  currentWidth?: number;
  currentHeight?: number;
  onWidthDrag?: (width: number | null) => void;
  onHeightDrag?: (height: number | null) => void;
}

const NO_TABS: string[] = [];

/** Last path segment — the file name shown on the tab. */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function sourceIcon(source: PeekFileValue["source"]) {
  switch (source) {
    case "definition":
      return <ArrowUpRight size={13} aria-hidden />;
    case "references":
      return <List size={13} aria-hidden />;
    case "outline":
      return <ListTree size={13} aria-hidden />;
    case "search":
    default:
      return <Search size={13} aria-hidden />;
  }
}

/**
 * Files tool (R4, R5, §4):
 * Overlays FilesLeftPane over FilePreviewPane rather than splitting via MasterDetailShell.
 * The content pane pads itself by the expanded panel width when open.
 * Drag-to-resize is supported on the panel's right edge (§4a).
 * The rail has zero content-side inset so FilePreviewPane renders full width underneath (§4b).
 */
export function FilesPanel({
  api,
  worktreeId,
  scope = "worktree",
  onOpenQuickOpen,
  currentWidth,
  currentHeight,
  onWidthDrag,
  onHeightDrag,
}: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const openTabs = useWorkspaceStore((s) => s.openFileTabsByWorktree[wt] ?? NO_TABS);
  const activeIdx = useWorkspaceStore((s) => s.activeFileTabIdxByWorktree[wt] ?? -1);
  const closeFileTab = useWorkspaceStore((s) => s.closeFileTab);
  const setActiveFileTabIdx = useWorkspaceStore((s) => s.setActiveFileTabIdx);
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);
  const peekFile = useWorkspaceStore((s) => s.peekFile);
  const clearPeekFile = useWorkspaceStore((s) => s.clearPeekFile);
  const peekActive = !!peekFile && peekFile.worktreeId === wt;

  const { isPanelOpen: insetPanelOpen } = useToolsInset();
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const isPanelOpen = insetPanelOpen || fileTreeVisible;

  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[wt] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const storedWidth = useWorkspaceStore(
    (s) => s.filesLeftPaneWidthByWorktree[wt] ?? FILES_LEFT_PANE_DEFAULT_WIDTH,
  );
  const storedHeight = useWorkspaceStore(
    (s) => s.filesLeftPaneHeightByWorktree[wt] ?? FILES_LEFT_PANE_DEFAULT_HEIGHT,
  );
  const [localDragWidth, setLocalDragWidth] = useState<number | null>(null);
  const [localDragHeight, setLocalDragHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Padding transition only for an explicit toggle (toggleFileTree /
  // setMasterDetailVertical raise this hint for ~300ms) — never derived from
  // `isPanelOpen`/`masterDetailVertical`/width changing, which a worktree
  // switch to a differently-persisted layout also does. See
  // `layoutTransitionHint` in useStore.ts.
  const animatePadding = useWorkspaceStore((s) => s.layoutTransitionHint === "files");
  const activeWidth = currentWidth ?? localDragWidth ?? storedWidth;
  const activeHeight = currentHeight ?? localDragHeight ?? storedHeight;

  // The panel is an overlay on this pane; clamp its size to the pane's OWN
  // measured width/height (not window.innerWidth/innerHeight), so dragging can
  // never push the preview off-screen or leave a persisted size unreachable
  // when the pane later narrows (split-drag, exiting fullscreen, a mobile
  // stacked split).
  const paneRef = useRef<HTMLDivElement>(null);
  const clampDim = useCallback(
    (px: number) => {
      const rect = paneRef.current?.getBoundingClientRect();
      if (masterDetailVertical) {
        const paneH = rect?.height ?? window.innerHeight;
        const max = Math.min(FILES_LEFT_PANE_MAX_HEIGHT, paneH - 80);
        return Math.min(max, Math.max(FILES_LEFT_PANE_MIN_HEIGHT, px));
      } else {
        const paneW = rect?.width ?? window.innerWidth;
        const max = Math.min(FILES_LEFT_PANE_MAX_WIDTH, paneW - 80);
        return Math.min(max, Math.max(FILES_LEFT_PANE_MIN_WIDTH, px));
      }
    },
    [masterDetailVertical],
  );

  const cleanupDragRef = useRef<(() => void) | null>(null);
  // Empty deps: run the cleanup (and release any mid-drag width/height
  // override) only on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    return () => {
      if (cleanupDragRef.current) {
        cleanupDragRef.current();
      }
      // If we unmount mid-drag (dragWidth/dragHeight still overriding the
      // stored size), release the override so ToolPanel doesn't stay stuck
      // on the dragged value.
      onWidthDrag?.(null);
      onHeightDrag?.(null);
    };
  }, []);

  // Pointer Events resize (mouse + touch + pen unified via setPointerCapture) —
  // same mechanism the terminal/agent PanelResizeHandle divider uses, which is
  // why that one already works on a phone while this hand-rolled handle didn't.
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startPos = masterDetailVertical ? e.clientY : e.clientX;
      const startDim = masterDetailVertical ? activeHeight : activeWidth;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = masterDetailVertical ? "row-resize" : "col-resize";
      setIsDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      function onMove(ev: PointerEvent) {
        const currentPos = masterDetailVertical ? ev.clientY : ev.clientX;
        const nextDim = clampDim(startDim + (currentPos - startPos));
        if (masterDetailVertical) {
          if (onHeightDrag) {
            onHeightDrag(nextDim);
          } else {
            setLocalDragHeight(nextDim);
          }
        } else {
          if (onWidthDrag) {
            onWidthDrag(nextDim);
          } else {
            setLocalDragWidth(nextDim);
          }
        }
      }

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        cleanupDragRef.current = null;
      }

      function onUp(ev: PointerEvent) {
        cleanup();
        const currentPos = masterDetailVertical ? ev.clientY : ev.clientX;
        const finalDim = clampDim(startDim + (currentPos - startPos));
        if (masterDetailVertical) {
          useWorkspaceStore.getState().setFilesLeftPaneHeight(wt, finalDim);
          setIsDragging(false);
          if (onHeightDrag) {
            onHeightDrag(null);
          } else {
            setLocalDragHeight(null);
          }
        } else {
          useWorkspaceStore.getState().setFilesLeftPaneWidth(wt, finalDim);
          setIsDragging(false);
          if (onWidthDrag) {
            onWidthDrag(null);
          } else {
            setLocalDragWidth(null);
          }
        }
      }

      cleanupDragRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [masterDetailVertical, activeHeight, activeWidth, onHeightDrag, onWidthDrag, wt, clampDim],
  );

  // Handle to FilesLeftPane's active-mode tabbable row
  const leftPaneFocusHandle = useRef<FilesLeftPaneHandle | null>(null);
  const isFirstRender = useRef(true);

  const refocusLeftPane = useCallback(() => {
    if (leftPaneFocusHandle.current) {
      leftPaneFocusHandle.current.focusActivePane();
    }
  }, []);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!isPanelOpen) return;
    requestAnimationFrame(() => refocusLeftPane());
  }, [isPanelOpen, refocusLeftPane]);

  usePendingFileOpens(api, worktreeId);

  const rightPaneTopbar = (
    <>
      <div className="files-topbar__tabs" role="tablist" aria-label="Open files">
        {openTabs.length === 0 && !peekActive && (
          <span className="files-topbar__empty">No file open</span>
        )}
        {openTabs.map((path, idx) => {
          const isActive = idx === activeIdx && !peekActive;
          return (
            <span
              key={`${idx}:${path}`}
              className="files-topbar__tab"
              data-active={isActive || undefined}
              title={path}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveFileTabIdx(wt, idx)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeFileTab(wt, idx);
                }
              }}
            >
              <FileText size={13} aria-hidden />
              <span className="files-topbar__tab-name">{baseName(path)}</span>
              <button
                type="button"
                className="files-topbar__tab-close"
                aria-label={`Close ${baseName(path)}`}
                title="Close file"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFileTab(wt, idx);
                }}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        {peekActive && peekFile && (() => {
          const src = peekFile.source ?? "search";
          const isExternal = Boolean(peekFile.external);
          const display = isExternal
            ? (peekFile.external?.displayPath ?? peekFile.path)
            : baseName(peekFile.path);
          return (
            <span
              className="files-topbar__tab files-topbar__tab--preview"
              data-active
              title={`${isExternal ? (peekFile.external?.displayPath ?? peekFile.path) : peekFile.path} (${src} preview — not open as a tab)`}
              role="tab"
              aria-selected
              onDoubleClick={() => {
                if (isExternal) return;
                setActiveFilePathAtLine(
                  peekFile.worktreeId,
                  peekFile.path,
                  peekFile.line,
                  peekFile.matchText ?? undefined,
                );
              }}
            >
              {sourceIcon(src)}
              <span className="files-topbar__tab-name">{display}</span>
              {isExternal && (
                <span className="files-topbar__tab-badge files-topbar__tab-badge--external">
                  outside workspace
                </span>
              )}
              <button
                type="button"
                className="files-topbar__tab-close"
                aria-label={`Close ${src} preview`}
                title={`Close ${src} preview`}
                onClick={(e) => {
                  e.stopPropagation();
                  clearPeekFile();
                }}
              >
                <X size={12} />
              </button>
            </span>
          );
        })()}
      </div>
      <button
        type="button"
        className="files-topbar__add"
        aria-label="Open another file"
        title="Open file (Ctrl+P)"
        onClick={onOpenQuickOpen}
      >
        <Plus size={13} />
      </button>
    </>
  );

  return (
    <div
      ref={paneRef}
      className="files-panel"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
      }}
    >
      {/* Expanded left pane as an overlay (R4). Always mounted (R16), hidden via display:none when closed */}
      <div
        className={`files-left-pane-overlay${isPanelOpen ? " files-left-pane-overlay--open" : ""}`}
        style={{
          position: "absolute",
          top: 0,
          bottom: masterDetailVertical ? undefined : 0,
          left: "var(--tools-rail-w, 36px)",
          right: masterDetailVertical ? 0 : undefined,
          width: masterDetailVertical ? undefined : "var(--tools-rail-panel-w, 240px)",
          height: masterDetailVertical ? "var(--tools-rail-panel-h, 240px)" : undefined,
          zIndex: 20,
          background: "var(--bg-secondary)",
          borderRight: masterDetailVertical ? undefined : "var(--border-width) solid var(--border-default)",
          borderBottom: masterDetailVertical ? "var(--border-width) solid var(--border-default)" : undefined,
          display: isPanelOpen ? "flex" : "none",
          flexDirection: "column",
          overflow: "visible",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <FilesLeftPane ref={leftPaneFocusHandle} api={api} worktreeId={worktreeId} scope={scope} />
        </div>
        <div
          className={`files-left-pane-resize-handle${masterDetailVertical ? " files-left-pane-resize-handle--horizontal" : ""}`}
          role="separator"
          aria-orientation={masterDetailVertical ? "horizontal" : "vertical"}
          aria-label={masterDetailVertical ? "Resize files top panel" : "Resize files side panel"}
          aria-valuenow={masterDetailVertical ? activeHeight : activeWidth}
          aria-valuemin={masterDetailVertical ? FILES_LEFT_PANE_MIN_HEIGHT : FILES_LEFT_PANE_MIN_WIDTH}
          aria-valuemax={masterDetailVertical ? FILES_LEFT_PANE_MAX_HEIGHT : FILES_LEFT_PANE_MAX_WIDTH}
          tabIndex={0}
          data-dragging={isDragging || undefined}
          onPointerDown={startResize}
          onKeyDown={(e) => {
            if (masterDetailVertical) {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = clampDim(activeHeight - 10);
                useWorkspaceStore.getState().setFilesLeftPaneHeight(wt, next);
                onHeightDrag?.(null);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = clampDim(activeHeight + 10);
                useWorkspaceStore.getState().setFilesLeftPaneHeight(wt, next);
                onHeightDrag?.(null);
              }
            } else {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                const next = clampDim(activeWidth - 10);
                useWorkspaceStore.getState().setFilesLeftPaneWidth(wt, next);
                onWidthDrag?.(null);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                const next = clampDim(activeWidth + 10);
                useWorkspaceStore.getState().setFilesLeftPaneWidth(wt, next);
                onWidthDrag?.(null);
              }
            }
          }}
        />
      </div>

      {/* Content pane (R4, R5, §4b): full width underneath, padded left/top to avoid overlay only when open */}
      <div
        className="files-panel__content"
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          paddingLeft: !masterDetailVertical && isPanelOpen ? "calc(var(--tools-rail-w, 36px) + var(--tools-rail-panel-w, 240px))" : "0px",
          paddingTop: masterDetailVertical && isPanelOpen ? "var(--tools-rail-panel-h, 240px)" : "0px",
          transition: isDragging || !animatePadding
            ? "none"
            : masterDetailVertical
              ? "padding-top 0.15s ease"
              : "padding-left 0.15s ease",
        }}
      >
        {/* Topbar: open file tabs, height matching desktop TopBar (32px), padded right to clear ToolFullscreenButton + orientation toggle.
            Padded left by rail width only when panel is closed or stacked so tabs avoid the rail icons (§4b). */}
        <div
          className="files-topbar"
          style={{
            height: "32px",
            minHeight: "32px",
            maxHeight: "32px",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "stretch",
            paddingLeft: (!isPanelOpen || masterDetailVertical) ? "var(--tools-rail-w, 36px)" : "0px",
            paddingRight: "68px",
          }}
        >
          {rightPaneTopbar}
        </div>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />
        </div>
      </div>
    </div>
  );
}
