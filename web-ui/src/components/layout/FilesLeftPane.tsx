import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { SearchPanel } from "@/components/tools/SearchPanel";

interface FilesLeftPaneProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
}

/** Imperative handle exposing the active mode's tabbable row to
 *  `MasterDetailShell`'s refocus effects (Phase 3.3/3.5a, B4a) — scoped to the
 *  ACTIVE mode's container, never a `display:none` inactive pane. */
export interface FilesLeftPaneHandle {
  focusActivePane: () => void;
}

/**
 * Mode-switching wrapper for the Files tool's left pane. Both the tree body
 * (`FileTreeSidebar`, header included) and the search body (`SearchPanel`,
 * own controls included) are ALWAYS mounted and CSS-hidden when inactive
 * (Requirement 9) — never conditionally unmounted on a rail-mode switch, so
 * each mode's async state (expanded dirs, debounce/abort state) survives.
 *
 * Per the resolved design decision for Phase 3.3, there is NO separate header
 * slot here: each mode's root component owns its own header inside itself.
 */
export const FilesLeftPane = forwardRef<FilesLeftPaneHandle, FilesLeftPaneProps>(
  function FilesLeftPane({ api, worktreeId, scope = "worktree" }, ref) {
    const key = worktreeId ?? "__none__";
    const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[key] ?? "tree");
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const searchContainerRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        focusActivePane() {
          const container = mode === "tree" ? treeContainerRef.current : searchContainerRef.current;
          const focusable =
            container?.querySelector<HTMLElement>("[tabindex='0']") ??
            container?.querySelector<HTMLElement>("[tabindex]");
          focusable?.focus({ preventScroll: true });
        },
      }),
      [mode],
    );

    return (
      <>
        <div
          ref={treeContainerRef}
          className={mode === "tree" ? "files-left-pane__body" : "files-left-pane__body files-left-pane__hidden"}
        >
          <FileTreeSidebar api={api} contextId={worktreeId} scope={scope} />
        </div>
        <div
          ref={searchContainerRef}
          className={mode === "search" ? "files-left-pane__body" : "files-left-pane__body files-left-pane__hidden"}
        >
          <SearchPanel api={api} worktreeId={worktreeId} scope={scope} />
        </div>
      </>
    );
  },
);
