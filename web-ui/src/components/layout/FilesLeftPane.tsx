import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { SearchPanel } from "@/components/tools/SearchPanel";
import { ReferencesPanel } from "@/components/tools/ReferencesPanel";
import { OutlinePanel } from "@/components/tools/OutlinePanel";

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
 * Mode-switching wrapper for the Files tool's left pane. The tree body,
 * search body, references body, and outline body are ALWAYS mounted and CSS-hidden when inactive
 * (Requirement 9) — never conditionally unmounted on a rail-mode switch, so
 * each mode's async state survives.
 */
export const FilesLeftPane = forwardRef<FilesLeftPaneHandle, FilesLeftPaneProps>(
  function FilesLeftPane({ api, worktreeId, scope = "worktree" }, ref) {
    const key = worktreeId ?? "__none__";
    const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[key] ?? "tree");
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const searchContainerRef = useRef<HTMLDivElement>(null);
    const referencesContainerRef = useRef<HTMLDivElement>(null);
    const outlineContainerRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        focusActivePane() {
          const containerMap: Record<string, HTMLDivElement | null> = {
            tree: treeContainerRef.current,
            search: searchContainerRef.current,
            references: referencesContainerRef.current,
            outline: outlineContainerRef.current,
          };
          const container = containerMap[mode] ?? treeContainerRef.current;
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
        <div
          ref={outlineContainerRef}
          className={mode === "outline" ? "files-left-pane__body" : "files-left-pane__body files-left-pane__hidden"}
        >
          <OutlinePanel api={api} worktreeId={worktreeId} scope={scope} />
        </div>
        <div
          ref={referencesContainerRef}
          className={mode === "references" ? "files-left-pane__body" : "files-left-pane__body files-left-pane__hidden"}
        >
          <ReferencesPanel api={api} worktreeId={worktreeId} scope={scope} />
        </div>
      </>
    );
  },
);
