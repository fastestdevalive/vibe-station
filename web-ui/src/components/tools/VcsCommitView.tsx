import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, FileScope } from "@/api/types";
import { ChangedFileList } from "@/components/layout/ChangedFileList";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { DockedListLayout } from "@/components/layout/DockedListLayout";
import { DiffScopeSelector } from "@/components/layout/DiffScopeSelector";
import { ModeHeaderActionsHost, ToolActionsHost } from "@/components/layout/TopActionsSlot";
import { Chip } from "@/components/ui/Chip";
import { HOST_PRIORITY } from "@/context/TopActionsContext";
import { useToolsInset } from "@/context/ToolsInsetContext";
import { useWorkspaceStore } from "@/hooks/useStore";

interface VcsCommitViewProps {
  api: ApiInstance;
  worktreeId: string;
  /** Full or abbreviated commit sha to view (Decision 9). */
  sha: string;
  /** Returns to the commit graph (VcsPanel). */
  onBack: () => void;
  /** `"worktree"` (default) or `"project"` — which id namespace `worktreeId`
   *  indexes into. Threaded into the changed-paths fetch and `FilePreviewPane`. */
  scope?: FileScope;
  /** When present, this commit lives in a submodule's history rather than the
   *  checkout root; threaded into `listChangedPaths` + `FilePreviewPane`. */
  submodule?: string;
}

/** First 7 chars — matches `CommitLogEntry.shortSha`'s convention closely
 *  enough for a breadcrumb label without threading the full entry through. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Commit-scoped master-detail view (Decision 5, item 9) — a controlled
 * `ChangedFileList` + `FilePreviewPane` (Decision 6) in the shared
 * `DockedListLayout`: the changed-file list is docked on the RIGHT of the diff,
 * exactly like the Files tab's list (same persisted size, resize handle on its
 * left edge, stacked option, phone clamps). Opening a file here never clobbers the Files tab's own
 * open file / diff scope. Owns its own `selectedPath` state — nothing here
 * touches `useWorkspaceStore`'s `activeFilePath`/`diffScopeByWorktree`.
 */
export function VcsCommitView({
  api,
  worktreeId,
  sha,
  onBack,
  scope = "worktree",
  submodule,
}: VcsCommitViewProps) {
  const [entries, setEntries] = useState<ChangedPathEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // The changed-file sidebar's visibility is driven by the VCS rail icon
  // (scoped to this commit view, independent of the Files rail-mode's own
  // `fileTreeVisible`). Defaults to visible on first open (State B); the rail
  // icon toggles it closed (State C) / open again without exiting the commit.
  const sidebarVisible = useWorkspaceStore((s) => s.vcsSidebarVisibleByWorktree[worktreeId] ?? true);

  const { listHostsGlobal, listHostsPane } = useToolsInset();
  const listRef = useRef<HTMLDivElement>(null);
  // Arrow keys work as soon as a commit opens (and when the VCS rail icon re-opens the list).
  useEffect(() => {
    if (!sidebarVisible) return;
    const id = requestAnimationFrame(() => {
      const el = listRef.current;
      (el?.querySelector<HTMLElement>("[tabindex='0']") ?? el?.querySelector<HTMLElement>("[tabindex]"))?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [sidebarVisible]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(worktreeId, "commit", sha, scope, submodule);
        if (!cancelled) {
          setEntries(list);
          setLoading(false);
          if (list.length > 0) setSelectedPath(list[0]!.path);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not resolve commit sha");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, worktreeId, sha, scope, submodule]);

  const topbarExtra = (
    <>
      <div className="files-topbar__breadcrumb">
        <DiffScopeSelector
          scope="commit"
          commitLabel={`${submodule ? `${submodule} · ` : ""}commit #${shortSha(sha)}`}
          onBack={onBack}
        />
      </div>
      {/* Same hosting rule as the Files bar: pane controls here unless the open list's header carries them (stacked,
          or phone side-by-side); the chip's reserve moves to the list header while the desktop list is open. */}
      <ToolActionsHost
        when={!listHostsPane}
        priority={listHostsGlobal ? HOST_PRIORITY.filesBarFallback : HOST_PRIORITY.default}
      />
    </>
  );

  return (
    <DockedListLayout
      wt={worktreeId}
      open={sidebarVisible}
      handleLabel="changed files"
      topbarClassName="vcs-topbar"
      topbar={topbarExtra}
      list={
        <div ref={listRef} className="commit-files">
          <div className="commit-files__head actions-row">
            <span className="commit-files__title">Changes</span>
            {!loading && !error ? (
              <Chip size="sm" aria-label={`${entries.length} changed ${entries.length === 1 ? "file" : "files"}`}>
                {entries.length}
              </Chip>
            ) : null}
            <ModeHeaderActionsHost mode="commit" />
          </div>
          <ChangedFileList
            entries={entries}
            loading={loading}
            error={error}
            controlled={{ activePath: selectedPath, onSelect: setSelectedPath }}
          />
        </div>
      }
    >
      <FilePreviewPane
        api={api}
        worktreeId={worktreeId}
        scope={scope}
        controlled={{
          path: selectedPath,
          scope: "commit",
          commitSha: sha,
          submodule,
          deleted: entries.find((e) => e.path === selectedPath)?.status === "D",
        }}
      />
    </DockedListLayout>
  );
}
