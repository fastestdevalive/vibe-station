import { ArrowUpRight, FileText, List, ListTree, Plus, Search, X } from "lucide-react";
import { useRef } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore, type PeekFileValue } from "@/hooks/useStore";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { MasterDetailShell } from "@/components/layout/MasterDetailShell";
import { FilesLeftRail } from "@/components/layout/FilesLeftRail";
import { FilesLeftPane, type FilesLeftPaneHandle } from "@/components/layout/FilesLeftPane";
import { usePendingFileOpens } from "@/hooks/usePendingFileOpens";

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
 * Files tool — a thin wrapper over `MasterDetailShell` (Decision 5): the file
 * tree/search pane on the left and the preview on the right, via the shared
 * shell's resizable split. The panel-visibility toggle lives in
 * `FilesLeftRail`; the shell's own topbar is unused here (`treeToggle`/
 * `layoutToggle` both `false`) since the open-file tab strip is rendered
 * directly in this component's own `rightPaneTopbar` — live-review feedback
 * moved it out of a full-width bar that used to span above both panes, to
 * sit scoped to just the preview pane. The layout-orientation toggle lives
 * in `ToolPanel.tsx`, attached to the top-level "Files" tab button itself
 * (not here) — see that file's own comment for why.
 */
export function FilesPanel({ api, worktreeId, scope = "worktree", onOpenQuickOpen }: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const openTabs = useWorkspaceStore((s) => s.openFileTabsByWorktree[wt] ?? NO_TABS);
  const activeIdx = useWorkspaceStore((s) => s.activeFileTabIdxByWorktree[wt] ?? -1);
  const closeFileTab = useWorkspaceStore((s) => s.closeFileTab);
  const setActiveFileTabIdx = useWorkspaceStore((s) => s.setActiveFileTabIdx);
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);
  // A dedicated, always-separate "search preview" tab (live-review feedback):
  // while arrowing through content-search results, show ONE extra tab entry
  // reflecting the currently peeked file, distinct from any real tab —
  // rather than either silently retargeting an existing real tab's identity,
  // or spamming a permanent tab per keystroke. It disappears the moment
  // `peekFile` clears, which already happens on every path that should end
  // it: closing/switching out of search, clearing the query (S-1's
  // zero-results rule), or the user committing a match — committing clears
  // `peekFile` as the very first thing every commit action does (B1), so
  // "Enter opens a real tab" and "the preview tab disappears" happen in the
  // same store update, satisfying "exits unless Enter, which opens a new
  // tab" without any extra wiring here.
  const peekFile = useWorkspaceStore((s) => s.peekFile);
  const clearPeekFile = useWorkspaceStore((s) => s.clearPeekFile);
  const peekActive = !!peekFile && peekFile.worktreeId === wt;
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);

  // Handle to FilesLeftPane's active-mode tabbable row, consumed by
  // MasterDetailShell's refocus effects (Phase 3.3/3.5a, B4a).
  const leftPaneFocusHandle = useRef<FilesLeftPaneHandle | null>(null);

  usePendingFileOpens(api, worktreeId);

  const rightPaneTopbar = (
    <>
      {/* Open-file tab strip (multi-tab). Deliberately does NOT include the
          "+" add-file button — this whole div scrolls horizontally
          (overflow-x: auto) once the tabs overflow, and an element placed
          as its last child would scroll off with them, effectively
          disappearing until the user manually scrolled all the way over.
          The add button renders as a separate, fixed sibling below instead,
          so it stays reachable regardless of how many tabs are open. (The
          layout-orientation toggle that also briefly lived here has since
          moved to the top-level "Files" tab button — see ToolPanel.tsx.) */}
      <div className="files-topbar__tabs" role="tablist" aria-label="Open files">
        {openTabs.length === 0 && !peekActive && (
          <span className="files-topbar__empty">No file open</span>
        )}
        {openTabs.map((path, idx) => {
          // Only the peek tab reads as "active" while a peek is live — the
          // real tab it would otherwise point at dims until the peek ends.
          const isActive = idx === activeIdx && !peekActive;
          return (
            <span
              // Index-qualified: paths are unique by store invariant, but a
              // bare path key would silently collapse two tabs into one dead
              // "ghost" tab if that invariant ever regressed.
              key={`${idx}:${path}`}
              className="files-topbar__tab"
              data-active={isActive || undefined}
              title={path}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveFileTabIdx(wt, idx)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFileTab(wt, idx); } }}
            >
              <FileText size={13} aria-hidden />
              <span className="files-topbar__tab-name">{baseName(path)}</span>
              <button
                type="button"
                className="files-topbar__tab-close"
                aria-label={`Close ${baseName(path)}`}
                title="Close file"
                onClick={(e) => { e.stopPropagation(); closeFileTab(wt, idx); }}
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
                onClick={(e) => { e.stopPropagation(); clearPeekFile(); }}
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
    <div className="files-panel__row">
      <FilesLeftRail worktreeId={wt} />
      <MasterDetailShell
        storageKey={wt}
        worktreeId={worktreeId}
        treeToggle={false}
        layoutToggle={false}
        leftPaneFocusHandle={leftPaneFocusHandle}
        rightPaneTopbar={rightPaneTopbar}
        leftPane={
          <FilesLeftPane ref={leftPaneFocusHandle} api={api} worktreeId={worktreeId} scope={scope} />
        }
        rightPane={<FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />}
      />
    </div>
  );
}
