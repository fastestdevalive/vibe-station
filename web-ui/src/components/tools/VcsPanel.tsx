import { FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, CommitLogEntry, FileScope, PrStatus, SubmoduleInfo } from "@/api/types";
import { DockedListLayout } from "@/components/layout/DockedListLayout";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { ToolActionsHost } from "@/components/layout/TopActionsSlot";
import { splitOwnCommits } from "@/components/tools/VcsCommitRow";
import { VcsSubmodules } from "@/components/tools/VcsSubmodules";
import { VcsCommitList } from "@/components/vcs/VcsCommitList";
import { VcsSidebar } from "@/components/vcs/VcsSidebar";
import { getShaFiles, setShaFiles, useVcsCacheStore, vcsKey } from "@/components/vcs/vcsCacheStore";
import { VCS_PAGE_SIZE, useVcsCommits } from "@/components/vcs/useVcsCommits";
import { HOST_PRIORITY } from "@/context/TopActionsContext";
import { useToolsInset } from "@/context/ToolsInsetContext";
import { useSubmoduleCommits } from "@/hooks/useSubmoduleCommits";
import { useWorkspaceStore } from "@/hooks/useStore";

export { prStatusMessage } from "@/components/vcs/VcsPrSlot";

/**
 * Keeps the open commit's list in the cache while the sidebar is docked (no commit list is mounted then, and the
 * sidebar's subject, older/newer and `]`/`[` read that cache). Renders nothing; `useVcsCommits` is the owner.
 */
function VcsCommitNavSource({ api, id, scope, submodule }: { api: ApiInstance; id: string; scope: FileScope; submodule?: string }) {
  useVcsCommits({ api, id, scope, submodule });
  return null;
}

interface VcsPanelProps {
  api: ApiInstance;
  worktreeId: string;
  /** Worktree's base branch (e.g. "main"): the `since <base>` label and the `from <base>` divider. */
  baseBranch?: string;
  /** Worktree's own branch (kept for callers; the branch chip is gone, the worktree bar names the branch). */
  branch?: string;
  /** `"worktree"` (default) or `"project"` — which id namespace `worktreeId` indexes into. Project scope has no
   *  base-branch filter and no PR lookups. */
  scope?: FileScope;
  /** PR status from the session store (branch-guarded), for the PR slot's message row. */
  prStatus?: PrStatus | null;
}

type Level = "commit" | "list";

interface CommitFiles {
  /** `${sha}|${submodule}`: the files belong to this commit only. */
  key: string;
  entries: ChangedPathEntry[];
  loading: boolean;
  error: string | null;
}

const NO_FILES: CommitFiles = { key: "", entries: [], loading: true, error: null };

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The VCS tab (tools-pane-rework B5). Nothing selected: the commit list fills the pane (its own header, the PR slot,
 * then the rows; submodules below). A commit selected: the list docks on the right as a two-level sidebar
 * (`commit` = details + files, `list` = the compact list with the open commit marked), the file preview stays in
 * the content column. Commit selection lives in the workspace store (`vcsSelectedCommitByWorktree`); the sidebar level
 * is local UI state here (Decision 7). Commit lists come from `vcsCacheStore`; per-sha file lists are cached there too.
 */
export function VcsPanel({ api, worktreeId, baseBranch, scope = "worktree", prStatus = null }: VcsPanelProps) {
  const isProject = scope === "project";
  const selected = useWorkspaceStore((s) => s.vcsSelectedCommitByWorktree[worktreeId] ?? null);
  const setSelectedCommitStore = useWorkspaceStore((s) => s.setVcsSelectedCommit);
  const sidebarVisible = useWorkspaceStore((s) => s.vcsSidebarVisibleByWorktree[worktreeId] ?? true);
  const { listHostsGlobal, listHostsPane } = useToolsInset();

  const sha = selected?.sha ?? null;
  const sub = selected?.submodule;

  const [level, setLevel] = useState<Level>("commit");
  // "since <base>" (true) / "all history" (false): the list's view option, owned here so the sidebar's older/newer
  // steps through the same list the user sees. Project scope never filters (see `VcsCommitList`).
  const [sinceMain, setSinceMain] = useState(true);
  const [submodules, setSubmodules] = useState<SubmoduleInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [files, setFiles] = useState<CommitFiles>(NO_FILES);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const sinceMainEff = !isProject && sinceMain;
  const uninitializedPaths = useMemo(
    () => new Set(submodules.filter((s) => s.status === "uninitialized").map((s) => s.path)),
    [submodules],
  );
  const submoduleCommits = useSubmoduleCommits(api, worktreeId, scope, uninitializedPaths);
  const { reset: resetSubmodules } = submoduleCommits;

  // A worktree switch starts from the list level, the default view option and no open submodule rows.
  useEffect(() => {
    setSinceMain(true);
    setLevel("commit");
    resetSubmodules();
  }, [worktreeId, scope, resetSubmodules]);

  // Submodules: best-effort, never gate the commit list.
  useEffect(() => {
    let live = true;
    api
      .listSubmodules(worktreeId, scope)
      .catch(() => [] as SubmoduleInfo[])
      .then((list) => {
        if (live) setSubmodules(list);
      });
    return () => {
      live = false;
    };
  }, [api, worktreeId, scope]);

  // The open commit's changed files: per-sha cache first, else one fetch (then cached forever).
  useEffect(() => {
    if (sha === null) return;
    const shaKey = vcsKey(scope, worktreeId, sub);
    const fileKey = `${sha}|${sub ?? ""}`;
    const cached = getShaFiles(shaKey, sha);
    if (cached) {
      setFiles({ key: fileKey, entries: cached, loading: false, error: null });
      setSelectedPath(cached[0]?.path ?? null);
      return;
    }
    let live = true;
    setFiles({ key: fileKey, entries: [], loading: true, error: null });
    setSelectedPath(null);
    api.listChangedPaths(worktreeId, "commit", sha, scope, sub).then(
      (list) => {
        if (!live) return;
        setShaFiles(shaKey, sha, list);
        setFiles({ key: fileKey, entries: list, loading: false, error: null });
        setSelectedPath(list[0]?.path ?? null);
      },
      (e: unknown) => {
        if (!live) return;
        setFiles({
          key: fileKey,
          entries: [],
          loading: false,
          error: e instanceof Error ? e.message : "Could not resolve commit sha",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [api, worktreeId, scope, sha, sub]);

  // Focus the first row of the sidebar when it opens or a commit is picked (the old commit view's rule).
  useEffect(() => {
    if (!sidebarVisible || sha === null) return;
    const id = requestAnimationFrame(() => {
      const el = sidebarRef.current;
      (el?.querySelector<HTMLElement>("[tabindex='0']") ?? el?.querySelector<HTMLElement>("[tabindex]"))?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [sidebarVisible, sha]);

  const currentFiles = files.key === `${sha}|${sub ?? ""}` ? files : NO_FILES;
  const entries = currentFiles.entries;

  // The list the sidebar's older/newer steps through: the cached page in the open commit's scope.
  const navKey = vcsKey(scope, worktreeId, sub);
  const cachedEntry = useVcsCacheStore((s) => s.entries[navKey]);
  const pageCommits = useMemo<CommitLogEntry[]>(
    () =>
      cachedEntry ? cachedEntry.commits.slice(0, cachedEntry.pageLimit > 0 ? cachedEntry.pageLimit : VCS_PAGE_SIZE) : [],
    [cachedEntry],
  );
  const navList = useMemo(() => (sinceMainEff ? splitOwnCommits(pageCommits) : pageCommits), [pageCommits, sinceMainEff]);
  const idx = sha === null ? -1 : navList.findIndex((c) => c.sha === sha);
  const canOlder = idx >= 0 && idx < navList.length - 1;
  const canNewer = idx > 0;
  const commitMeta = sha === null ? null : (pageCommits.find((c) => c.sha === sha) ?? null);

  const openCommit = (nextSha: string, nextSub?: string) => {
    setLevel("commit");
    setSelectedCommitStore(worktreeId, nextSha, nextSub);
  };
  const step = (delta: 1 | -1) => {
    const next = navList[idx + delta];
    if (next) setSelectedCommitStore(worktreeId, next.sha, sub);
  };

  const submodulesBlock = (
    <VcsSubmodules
      submodules={submodules}
      states={submoduleCommits.byPath}
      onToggle={submoduleCommits.toggle}
      onLoadMore={submoduleCommits.loadMore}
      onOpenDiff={(nextSha, nextSub) => openCommit(nextSha, nextSub)}
      diffFromMainEff={sinceMainEff}
    />
  );

  if (sha === null) {
    return (
      <div className="vcs-panel">
        <VcsCommitList
          key={`${scope}:${worktreeId}`}
          api={api}
          id={worktreeId}
          scope={scope}
          baseBranch={baseBranch}
          prStatus={prStatus}
          onOpen={(nextSha) => openCommit(nextSha)}
          sinceMain={sinceMain}
          onSinceMainChange={setSinceMain}
          fullPane
        />
        {submodulesBlock}
      </div>
    );
  }

  const fileIndex = selectedPath ? entries.findIndex((e) => e.path === selectedPath) : -1;
  const topbar = (
    <>
      <div className="files-topbar__tabs vcs-topbar__tabs">
        <span className="files-topbar__tab vcs-topbar__file">
          <FileText size={13} aria-hidden />
          <span className="files-topbar__tab-name">{selectedPath ? baseName(selectedPath) : ""}</span>
          {fileIndex >= 0 ? (
            <span className="vcs-topbar__pos">
              {fileIndex + 1} of {entries.length}
            </span>
          ) : null}
        </span>
      </div>
      {/* Same hosting rule as the Files bar: pane controls here unless the open list's header carries them. */}
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
      handleLabel="commits"
      topbarClassName="vcs-topbar"
      topbar={topbar}
      list={
        <div ref={sidebarRef} className="vcs-sidebar">
          <VcsCommitNavSource api={api} id={worktreeId} scope={scope} submodule={sub} />
          <VcsSidebar
            level={level}
            activeSha={sha}
            list={{
              api,
              id: worktreeId,
              scope,
              baseBranch,
              prStatus,
              onOpen: (nextSha) => openCommit(nextSha),
              sinceMain,
              onSinceMainChange: setSinceMain,
            }}
            detail={{
              api,
              scopeId: worktreeId,
              scope,
              commit: commitMeta,
              sha,
              entries,
              filesLoading: currentFiles.loading,
              filesError: currentFiles.error,
              selectedPath,
              onSelectPath: setSelectedPath,
              canOlder,
              canNewer,
              onOlder: () => step(1),
              onNewer: () => step(-1),
              onUp: () => setLevel("list"),
            }}
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
          submodule: sub,
          deleted: entries.find((e) => e.path === selectedPath)?.status === "D",
        }}
      />
    </DockedListLayout>
  );
}
