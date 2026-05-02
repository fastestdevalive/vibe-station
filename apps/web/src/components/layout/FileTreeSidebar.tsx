import { File, FileText, Folder, FolderOpen, FolderTree, GitCompare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, DiffScope, TreeEntry } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ChangedFileList } from "@/components/layout/ChangedFileList";
import { useTreeWatch } from "@/hooks/useSubscription";

/** Sort folders before files, then alphabetical (case-insensitive). */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

interface NodeProps {
  api: ApiInstance;
  worktreeId: string | null;
  entry: TreeEntry;
  level: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
}

function TreeNode({ api, worktreeId, entry, level, expanded, toggle }: NodeProps) {
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
  }, [api, worktreeId, entry.path, isDir, isOpen]);

  function openFile() {
    if (!worktreeId) return;
    setActiveFile(entry.path);
    ensurePaneVisible(1);
  }

  return (
    <div role="tree">
      <div
        className="tree-row"
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        tabIndex={0}
        data-active={activePath === entry.path}
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
            />
          ))
        : null}
    </div>
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
  const [changed, setChanged] = useState<ChangedPathEntry[]>([]);
  const [changedLoading, setChangedLoading] = useState(false);
  const [changedError, setChangedError] = useState<string | null>(null);
  const { lastChanged } = useTreeWatch(api, activeWorktreeId);

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

  // Auto-expand all parent dirs of the active file so it's visible in the tree.
  const parentsOfActive = useMemo(() => {
    if (!activeFilePath) return [];
    const parts = activeFilePath.split("/").filter(Boolean);
    parts.pop(); // drop file name
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
      let changed = false;
      const next = new Set(prev);
      for (const p of parentsOfActive) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [parentsOfActive]);

  useEffect(() => {
    if (!activeWorktreeId || scope === "none") {
      setChanged([]);
      setChangedError(null);
      return;
    }
    let cancelled = false;
    setChangedLoading(true);
    setChangedError(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(activeWorktreeId);
        if (!cancelled) {
          setChanged(list);
          setChangedLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setChangedError(e instanceof Error ? e.message : "Failed to load changes");
          setChangedLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeWorktreeId, scope]);

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

  const diffMode = scope !== "none";

  return (
    <div className="pane pane-stack">
      {rightSidebarTabs}
      <div className="pane-header pane-header--compact file-tree-sidebar-header">
        <span className="file-tree-sidebar-header__title">{diffMode ? "Changes" : "Files"}</span>
        <div className="file-tree-sidebar-header__controls">
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
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "var(--space-2)",
        }}
        role="tree"
        aria-label={diffMode ? "Changed files" : "Worktree files"}
      >
        {diffMode ? (
          <ChangedFileList entries={changed} loading={changedLoading} error={changedError} />
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
            />
          ))
        )}
      </div>
    </div>
  );
}
