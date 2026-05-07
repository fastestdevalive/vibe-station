import { File, FileText, Folder, FolderOpen, FolderTree, GitCompare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, DiffScope, GitStatusChar, TreeEntry } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useTreeWatch } from "@/hooks/useSubscription";
import { ChangedFileList } from "@/components/layout/ChangedFileList";

/** Sort folders before files, then alphabetical (case-insensitive). */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function gitStatusBadgeChar(status: GitStatusChar): string {
  switch (status) {
    case "?":
      return "A";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return "?";
  }
}

/** Aggregate git tint for a directory from descendant paths (ao-142-style). */
function dirAggregateStatus(dirPath: string, m: Map<string, GitStatusChar>): GitStatusChar | undefined {
  const prefix = `${dirPath}/`;
  let hasMod = false;
  let hasNew = false;
  for (const [p, s] of m) {
    if (p === dirPath || p.startsWith(prefix)) {
      if (s === "M" || s === "D" || s === "R") hasMod = true;
      if (s === "A" || s === "?") hasNew = true;
    }
  }
  if (hasMod) return "M";
  if (hasNew) return "A";
  return undefined;
}

function rowGitModifier(entry: TreeEntry, m: Map<string, GitStatusChar>): string {
  const st =
    entry.type === "dir" ? dirAggregateStatus(entry.path, m) : m.get(entry.path);
  if (!st) return "";
  const token = st === "?" ? "U" : st;
  return ` tree-row--git-${token}`;
}

interface NodeProps {
  api: ApiInstance;
  worktreeId: string | null;
  entry: TreeEntry;
  level: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  gitStatusByPath: Map<string, GitStatusChar>;
  lastChanged: number;
}

function TreeNode({
  api,
  worktreeId,
  entry,
  level,
  expanded,
  toggle,
  gitStatusByPath,
  lastChanged,
}: NodeProps) {
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const ensurePaneVisible = useWorkspaceStore((s) => s.ensurePaneVisible);
  const activePath = useWorkspaceStore((s) => s.activeFilePath);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);

  const isDir = entry.type === "dir";
  const isOpen = expanded.has(entry.path);

  useEffect(() => {
    if (!isDir || !isOpen || !worktreeId) return;
    let cancelled = false;
    void (async () => {
      const list = await api.tree(worktreeId, entry.path);
      if (!cancelled) setChildren(sortEntries(list));
    })();
    return () => {
      cancelled = true;
    };
  }, [api, worktreeId, entry.path, isDir, isOpen, lastChanged]);

  function openFile() {
    if (!worktreeId) return;
    setActiveFile(entry.path);
    ensurePaneVisible(1);
  }

  const gitRowClass = rowGitModifier(entry, gitStatusByPath);
  const fileStatus = !isDir ? gitStatusByPath.get(entry.path) : undefined;
  const dirStatus = isDir ? dirAggregateStatus(entry.path, gitStatusByPath) : undefined;
  const badgeStatus = fileStatus ?? dirStatus;

  return (
    <>
      <div
        className={`tree-row${gitRowClass}`}
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        tabIndex={0}
        data-active={activePath === entry.path}
        data-git-status={badgeStatus ?? undefined}
        style={{ paddingLeft: `calc(${level} * var(--space-4) + var(--space-2))` }}
        onClick={() => (isDir ? toggle(entry.path) : openFile())}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (isDir) toggle(entry.path);
            else openFile();
          }
        }}
      >
        <span className="tree-row__kind-icon" aria-hidden>
          {isDir ? (
            isOpen ? (
              <FolderOpen size={15} strokeWidth={1.5} fill="currentColor" fillOpacity={0.18} />
            ) : (
              <Folder size={15} strokeWidth={1.5} fill="currentColor" fillOpacity={0.18} />
            )
          ) : isTextLikeFile(entry.name) ? (
            <FileText size={14} strokeWidth={1.5} />
          ) : (
            <File size={14} strokeWidth={1.5} />
          )}
        </span>
        <span className="tree-row__label">{entry.name}</span>
        {badgeStatus ? (
          <span className={`tree-row__git-badge tree-row__git-badge--${badgeStatus === "?" ? "U" : badgeStatus}`} aria-hidden>
            {gitStatusBadgeChar(badgeStatus)}
          </span>
        ) : null}
      </div>
      {isDir && isOpen && children
        ? children.map((ch) => (
            <TreeNode
              key={ch.path}
              api={api}
              worktreeId={worktreeId}
              entry={ch}
              level={level + 1}
              expanded={expanded}
              toggle={toggle}
              gitStatusByPath={gitStatusByPath}
              lastChanged={lastChanged}
            />
          ))
        : null}
    </>
  );
}

function isTextLikeFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "json", "yaml", "yml", "ts", "tsx", "js", "jsx", "css", "html", "py", "go", "rs", "java", "kt", "swift", "rb", "sh", "toml", "xml"].includes(ext);
}

interface FileTreeSidebarProps {
  api: ApiInstance;
}

export function FileTreeSidebar({ api }: FileTreeSidebarProps) {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setDiffScopeForWorktree = useWorkspaceStore((s) => s.setDiffScopeForWorktree);

  const scopeRaw = useWorkspaceStore((s) =>
    activeWorktreeId ? s.diffScopeByWorktree[activeWorktreeId] : undefined,
  );
  const scope: DiffScope = scopeRaw ?? "none";

  const [root, setRoot] = useState<TreeEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [localChanged, setLocalChanged] = useState<ChangedPathEntry[]>([]);
  const [branchChanged, setBranchChanged] = useState<ChangedPathEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const { lastChanged } = useTreeWatch(api, activeWorktreeId);

  const gitStatusByPath = useMemo(() => {
    const m = new Map<string, GitStatusChar>();
    for (const e of localChanged) {
      m.set(e.path, e.status);
    }
    return m;
  }, [localChanged]);

  const diffMode = scope !== "none";
  const groupedEntries =
    scope === "branch" ? branchChanged : scope === "local" ? localChanged : [];
  const scopedLoading = scope === "branch" ? branchLoading : localLoading;
  const groupedLoading = scopedLoading && groupedEntries.length === 0;
  const groupedError = scope === "branch" ? branchError : localError;

  useEffect(() => {
    if (!activeWorktreeId) {
      setRoot([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await api.tree(activeWorktreeId, "");
      if (!cancelled) setRoot(sortEntries(list));
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeWorktreeId, lastChanged]);

  const parentsOfActive = useMemo(() => {
    if (!activeFilePath) return [];
    const parts = activeFilePath.split("/").filter(Boolean);
    parts.pop();
    const out: string[] = [];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      out.push(acc);
    }
    return out;
  }, [activeFilePath]);

  useEffect(() => {
    if (parentsOfActive.length === 0) return;
    setExpanded((prev) => {
      let nextChanged = false;
      const next = new Set(prev);
      for (const p of parentsOfActive) {
        if (!next.has(p)) {
          next.add(p);
          nextChanged = true;
        }
      }
      return nextChanged ? next : prev;
    });
  }, [parentsOfActive]);

  useEffect(() => {
    if (!activeWorktreeId) {
      setLocalChanged([]);
      setLocalError(null);
      setLocalLoading(false);
      return;
    }
    let cancelled = false;
    setLocalLoading(true);
    setLocalError(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(activeWorktreeId, "local");
        if (!cancelled) {
          setLocalChanged(list);
          setLocalLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setLocalError(e instanceof Error ? e.message : "Failed to load git status");
          setLocalLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeWorktreeId, lastChanged]);

  useEffect(() => {
    if (!activeWorktreeId || scope !== "branch") {
      setBranchChanged([]);
      setBranchError(null);
      setBranchLoading(false);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    setBranchError(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(activeWorktreeId, "branch");
        if (!cancelled) {
          setBranchChanged(list);
          setBranchLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setBranchError(e instanceof Error ? e.message : "Failed to load branch changes");
          setBranchLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeWorktreeId, scope, lastChanged]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }

  function setScope(next: DiffScope) {
    if (activeWorktreeId) setDiffScopeForWorktree(activeWorktreeId, next);
  }

  function toggleDiffMode() {
    if (scope === "none") {
      setScope("local");
    } else {
      setScope("none");
    }
  }

  const rightSidebarTabs = (
    <div className="right-sidebar-tabs" role="tablist" aria-label="Right sidebar">
      <button
        type="button"
        role="tab"
        aria-selected
        className="right-sidebar-tab right-sidebar-tab--active"
        title="Files"
        aria-label="Files"
      >
        <FolderTree size={14} />
      </button>
    </div>
  );

  if (!activeWorktreeId) {
    return (
      <div className="pane pane-stack">
        {rightSidebarTabs}
        <div className="pane-header pane-header--compact">Files</div>
        <div className="empty-state">Select a worktree to view files</div>
      </div>
    );
  }

  return (
    <div className="pane pane-stack">
      {rightSidebarTabs}
      <div className="pane-header pane-header--compact file-tree-sidebar-header">
        <span className="file-tree-sidebar-header__title">{diffMode ? "Changes" : "Files"}</span>
        <div className="file-tree-sidebar-header__tail">
          <div className="file-tree-scope-slot" aria-hidden={!diffMode}>
            {diffMode ? (
              <div className="file-tree-scope-chips" role="group" aria-label="Diff scope">
                <button
                  type="button"
                  className={`file-tree-scope-chip ${scope === "local" ? "file-tree-scope-chip--active" : ""}`}
                  aria-pressed={scope === "local"}
                  onClick={() => setScope("local")}
                >
                  local
                </button>
                <button
                  type="button"
                  className={`file-tree-scope-chip ${scope === "branch" ? "file-tree-scope-chip--active" : ""}`}
                  aria-pressed={scope === "branch"}
                  onClick={() => setScope("branch")}
                >
                  branch
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`file-tree-diff-toggle ${diffMode ? "file-tree-diff-toggle--on" : ""}`}
            aria-pressed={diffMode}
            aria-label={diffMode ? "Diff view on" : "Diff view off"}
            title="Toggle diff view"
            onClick={toggleDiffMode}
          >
            <GitCompare size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div
        style={{ flex: 1, overflow: "auto", padding: "var(--space-2)" }}
        role={diffMode ? undefined : "tree"}
        aria-label={
          diffMode
            ? undefined
            : localLoading
              ? "Worktree files, git markers loading"
              : "Worktree files"
        }
      >
        <div style={{ minWidth: "max-content" }}>
          {!diffMode && localLoading ? (
            <div className="file-tree-git-loading" aria-live="polite">
              Loading git markers…
            </div>
          ) : null}
          {!diffMode && localError ? (
            <div className="file-tree-git-error" role="alert">
              {localError}
            </div>
          ) : null}
          {diffMode ? (
            <ChangedFileList entries={groupedEntries} loading={groupedLoading} error={groupedError} />
          ) : (
            root.map((e) => (
              <TreeNode
                key={e.path}
                api={api}
                worktreeId={activeWorktreeId}
                entry={e}
                level={0}
                expanded={expanded}
                toggle={toggle}
                gitStatusByPath={gitStatusByPath}
                lastChanged={lastChanged}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
