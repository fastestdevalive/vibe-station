import { ArrowUpRight, FileText, FolderOutput, List, ListTree, ListX, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore, type PeekFileValue } from "@/hooks/useStore";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { FilesLeftPane, type FilesLeftPaneHandle } from "@/components/layout/FilesLeftPane";
import { DockedListLayout } from "@/components/layout/DockedListLayout";
import { usePendingFileOpens } from "@/hooks/usePendingFileOpens";
import { HOST_PRIORITY } from "@/context/TopActionsContext";
import { isArtifactTabPath } from "@/lib/artifactTabPath";
import { Chip } from "@/components/ui/Chip";
import { useToolsInset } from "@/context/ToolsInsetContext";
import { ToolActionsHost } from "@/components/layout/TopActionsSlot";

interface FilesPanelProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
  onOpenQuickOpen?: () => void;
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
 * Overlays FilesLeftPane over FilePreviewPane rather than splitting the pane.
 * The list panel is docked on the RIGHT of the preview (left of the window rail column); the
 * content pane pads its right edge by the panel width when open.
 * Drag-to-resize is on the panel's LEFT edge (§4a): dragging left grows it.
 * Stacked (`masterDetailVertical`) keeps its top overlay. At <=768px the layout is the desktop one: the list
 * is full height on the right, the tab bar spans only the content column, its width clamped so the content keeps
 * >=144px; while it is open on a phone its header carries the pane controls. Stacked height is clamped so the
 * preview keeps >=96px.
 */
export function FilesPanel({
  api,
  worktreeId,
  scope = "worktree",
  onOpenQuickOpen,
}: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const openTabs = useWorkspaceStore((s) => s.openFileTabsByWorktree[wt] ?? NO_TABS);
  const activeIdx = useWorkspaceStore((s) => s.activeFileTabIdxByWorktree[wt] ?? -1);
  const closeFileTab = useWorkspaceStore((s) => s.closeFileTab);
  const closeAllFileTabs = useWorkspaceStore((s) => s.closeAllFileTabs);
  const setActiveFileTabIdx = useWorkspaceStore((s) => s.setActiveFileTabIdx);
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);
  const peekFile = useWorkspaceStore((s) => s.peekFile);
  const clearPeekFile = useWorkspaceStore((s) => s.clearPeekFile);
  const peekActive = !!peekFile && peekFile.worktreeId === wt;

  const { isPanelOpen: insetPanelOpen, listHostsGlobal, listHostsPane } = useToolsInset();
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const isPanelOpen = insetPanelOpen || fileTreeVisible;

  // Handle to FilesLeftPane's active-mode tabbable row
  const leftPaneFocusHandle = useRef<FilesLeftPaneHandle | null>(null);
  const isFirstRender = useRef(true);
  const fileTabsScrollRef = useRef<HTMLDivElement | null>(null);

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
    requestAnimationFrame(() => {
      // A keyboard user who just showed the pane from the actions chip's toggle keeps focus on it (the chip never
      // moves, so focus never has to follow it); Tab then enters the list.
      if (document.activeElement?.closest(".top-actions-anchor")) return;
      refocusLeftPane();
    });
  }, [isPanelOpen, refocusLeftPane]);

  usePendingFileOpens(api, worktreeId);

  // Mirror TabsStrip's wheel-to-horizontal-scroll behavior for the file tabs strip.
  useEffect(() => {
    const el = fileTabsScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active file tab visible in a long strip.
  const revealActiveTab = useCallback(() => {
    fileTabsScrollRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);
  useEffect(() => {
    revealActiveTab();
  }, [activeIdx, openTabs, peekActive, revealActiveTab]);
  // After a reload the strip gets its final width only once the panel group lays out: re-reveal on resize.
  useEffect(() => {
    const el = fileTabsScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => revealActiveTab());
    ro.observe(el);
    return () => ro.disconnect();
  }, [revealActiveTab]);

  const rightPaneTopbar = (
    <>
      <div
        className="files-topbar__tabs"
        role="tablist"
        aria-label="Open files"
        ref={fileTabsScrollRef}
      >
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
              {isArtifactTabPath(path) ? (
                <Chip
                  tone="warn"
                  size="sm"
                  className="files-topbar__tab-tag"
                  role="img"
                  aria-label="Outside project"
                  title={`Outside project: ${path}`}
                >
                  <FolderOutput size={10} aria-hidden />
                </Chip>
              ) : (
                <FileText size={13} aria-hidden />
              )}
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
      {openTabs.length >= 2 && (
        <button
          type="button"
          className="files-topbar__close-all"
          aria-label="Close all files"
          title="Close all files"
          onClick={() => closeAllFileTabs(wt, scope)}
        >
          <ListX size={13} />
        </button>
      )}
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
    <DockedListLayout
      wt={wt}
      open={isPanelOpen}
      handleLabel="files"
      topbar={
        <>
          {rightPaneTopbar}
          {/* Pane controls live here except under an open list that hosts them (stacked, or side-by-side on a
              phone: then the mode header does); the chip's reserve moves to the list header while the desktop
              side-by-side list is open (HOST_PRIORITY.filesBarFallback = fallback if that header has no host). */}
          <ToolActionsHost when={!listHostsPane} priority={listHostsGlobal ? HOST_PRIORITY.filesBarFallback : HOST_PRIORITY.default} />
        </>
      }
      list={<FilesLeftPane ref={leftPaneFocusHandle} api={api} worktreeId={worktreeId} scope={scope} />}
    >
      <FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />
    </DockedListLayout>
  );
}
