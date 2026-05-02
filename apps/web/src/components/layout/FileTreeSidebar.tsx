import { ChevronDown, ChevronRight, File, Folder, FolderOpen, FolderTree, GitCompare } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, DiffScope, TreeEntry } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ChangedFileList } from "@/components/layout/ChangedFileList";

interface NodeProps {
  api: ApiInstance;
  sessionId: string | null;
  entry: TreeEntry;
  level: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  showDots: boolean;
}

function TreeNode({ api, sessionId, entry, level, expanded, toggle, showDots }: NodeProps) {
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const activePath = useWorkspaceStore((s) => s.activeFilePath);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);

  const isDir = entry.type === "dir";
  const isOpen = expanded.has(entry.path);

  useEffect(() => {
    if (!isDir || !isOpen || !sessionId) return;
    let cancelled = false;
    void (async () => {
      const list = await api.tree(sessionId, entry.path);
      if (!cancelled) setChildren(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, entry.path, isDir, isOpen]);

  const hideDotfile = !showDots && entry.name.startsWith(".");

  if (hideDotfile) return null;

  return (
    <div role="tree">
      <div
        className="tree-row"
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        tabIndex={0}
        data-active={activePath === entry.path}
        style={{ paddingLeft: `calc(${level} * var(--space-4))` }}
        onClick={() => {
          if (isDir) {
            toggle(entry.path);
          } else if (sessionId) {
            setActiveFile(entry.path);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (isDir) toggle(entry.path);
            else if (sessionId) setActiveFile(entry.path);
          }
        }}
      >
        {isDir ? (
          <button
            type="button"
            className="icon-btn tree-row__chevron"
            aria-label={isOpen ? "Collapse folder" : "Expand folder"}
            onClick={(ev) => {
              ev.stopPropagation();
              toggle(entry.path);
            }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="tree-row__chevron-spacer" aria-hidden />
        )}
        <span className="tree-row__kind-icon" aria-hidden>
          {isDir ? (
            isOpen ? (
              <FolderOpen size={14} strokeWidth={1.75} />
            ) : (
              <Folder size={14} strokeWidth={1.75} />
            )
          ) : (
            <File size={14} strokeWidth={1.75} />
          )}
        </span>
        <span className="tree-row__label">{entry.name}</span>
      </div>
      {isDir && isOpen && children
        ? children.map((ch) => (
            <TreeNode
              key={ch.path}
              api={api}
              sessionId={sessionId}
              entry={ch}
              level={level + 1}
              expanded={expanded}
              toggle={toggle}
              showDots={showDots}
            />
          ))
        : null}
    </div>
  );
}

interface FileTreeSidebarProps {
  api: ApiInstance;
}

export function FileTreeSidebar({ api }: FileTreeSidebarProps) {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const showDotFiles = useWorkspaceStore((s) => s.showDotFiles);
  const toggleDotFiles = useWorkspaceStore((s) => s.toggleDotFiles);
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

  useEffect(() => {
    if (!activeSessionId || !activeWorktreeId) {
      setRoot([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await api.tree(activeSessionId, "");
      if (!cancelled) setRoot(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeSessionId, activeWorktreeId]);

  useEffect(() => {
    if (!activeSessionId || scope === "none") {
      setChanged([]);
      setChangedError(null);
      return;
    }
    let cancelled = false;
    setChangedLoading(true);
    setChangedError(null);
    void (async () => {
      try {
        const list = await api.listChangedPaths(activeSessionId);
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
  }, [api, activeSessionId, scope]);

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
          {!diffMode ? (
            <label className="file-tree-dotfiles">
              <input type="checkbox" checked={showDotFiles} onChange={toggleDotFiles} />
              dots
            </label>
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
              sessionId={activeSessionId}
              entry={e}
              level={0}
              expanded={expanded}
              toggle={toggle}
              showDots={showDotFiles}
            />
          ))
        )}
      </div>
    </div>
  );
}
