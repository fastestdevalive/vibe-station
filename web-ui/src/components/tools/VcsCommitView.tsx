import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry } from "@/api/types";
import { ChangedFileList } from "@/components/layout/ChangedFileList";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { MasterDetailShell } from "@/components/layout/MasterDetailShell";
import { DiffScopeSelector } from "@/components/layout/DiffScopeSelector";

interface VcsCommitViewProps {
  api: ApiInstance;
  worktreeId: string;
  /** Full or abbreviated commit sha to view (Decision 9). */
  sha: string;
  /** Returns to the commit graph (VcsPanel). */
  onBack: () => void;
}

/** First 7 chars — matches `CommitLogEntry.shortSha`'s convention closely
 *  enough for a breadcrumb label without threading the full entry through. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Commit-scoped master-detail view (Decision 5, item 9) — reuses
 * `MasterDetailShell` with a controlled `ChangedFileList` + `FilePreviewPane`
 * (Decision 6) so opening a file here never clobbers the Files tab's own
 * open file / diff scope. Owns its own `selectedPath` state — nothing here
 * touches `useWorkspaceStore`'s `activeFilePath`/`diffScopeByWorktree`.
 */
export function VcsCommitView({ api, worktreeId, sha, onBack }: VcsCommitViewProps) {
  const [entries, setEntries] = useState<ChangedPathEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(worktreeId, "commit", sha);
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
  }, [api, worktreeId, sha]);

  const topbarExtra = (
    <div className="files-topbar__breadcrumb">
      <DiffScopeSelector scope="commit" commitLabel={`commit #${shortSha(sha)}`} onBack={onBack} />
    </div>
  );

  return (
    <MasterDetailShell
      storageKey={`commit-${worktreeId}`}
      worktreeId={worktreeId}
      autoFocusTree
      topbarExtra={topbarExtra}
      leftPane={
        <ChangedFileList
          entries={entries}
          loading={loading}
          error={error}
          controlled={{ activePath: selectedPath, onSelect: setSelectedPath }}
        />
      }
      rightPane={
        <FilePreviewPane
          api={api}
          worktreeId={worktreeId}
          controlled={{ path: selectedPath, scope: "commit", commitSha: sha }}
        />
      }
    />
  );
}
