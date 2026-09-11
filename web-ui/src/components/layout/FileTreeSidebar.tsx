import { File, FileText, Folder, FolderOpen, GitCompare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, DiffScope, FileScope, GitStatusChar, TreeEntry } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useTreeWatch } from "@/hooks/useSubscription";
import { useRovingListNav, type RovingRow } from "@/hooks/useRovingListNav";
import { ChangedFileList } from "@/components/layout/ChangedFileList";
import { DiffScopeSelector } from "@/components/layout/DiffScopeSelector";

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

function rowGitModifier(path: string, isDir: boolean, m: Map<string, GitStatusChar>): string {
  const st = isDir ? dirAggregateStatus(path, m) : m.get(path);
  if (!st) return "";
  const token = st === "?" ? "U" : st;
  return ` tree-row--git-${token}`;
}

function isTextLikeFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "json", "yaml", "yml", "ts", "tsx", "js", "jsx", "css", "html", "py", "go", "rs", "java", "kt", "swift", "rb", "sh", "toml", "xml"].includes(ext);
}

/** A flattened, renderable row derived from `root` + `expanded` + `childrenByPath`
 *  — Decision 2's flat-row shape shared with `useRovingListNav`. */
interface FlatRow extends RovingRow {
  name: string;
  type: TreeEntry["type"];
  level: number;
}

/** Depth-first flatten of the visible portion of the tree (expanded dirs whose
 *  children have already loaded contribute their children; a not-yet-loaded
 *  expanded dir simply contributes no children rows yet). */
function flattenVisible(
  entries: TreeEntry[],
  level: number,
  expanded: Set<string>,
  childrenByPath: Map<string, TreeEntry[]>,
  out: FlatRow[],
): void {
  for (const e of entries) {
    const isDir = e.type === "dir";
    out.push({ path: e.path, name: e.name, type: e.type, level, expandable: isDir });
    if (isDir && expanded.has(e.path)) {
      const children = childrenByPath.get(e.path);
      if (children) flattenVisible(children, level + 1, expanded, childrenByPath, out);
    }
  }
}

interface FileTreeSidebarProps {
  api: ApiInstance;
  /** Context id: worktree id (fileScope="worktree") or project id ("project").
   *  Falls back to the active worktree when omitted (worktree callers). */
  contextId?: string | null;
  scope?: FileScope;
}

export function FileTreeSidebar({ api, contextId, scope: fileScope = "worktree" }: FileTreeSidebarProps) {
  const storeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  // The browsing context id: explicit prop (project or worktree) or the store's
  // active worktree for legacy callers.
  const activeWorktreeId = contextId !== undefined ? contextId : storeWorktreeId;
  const isProject = fileScope === "project";
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);
  const setDiffScopeForWorktree = useWorkspaceStore((s) => s.setDiffScopeForWorktree);
  const setTreeScopeForWorktree = useWorkspaceStore((s) => s.setTreeScopeForWorktree);

  const scopeRaw = useWorkspaceStore((s) =>
    activeWorktreeId ? s.diffScopeByWorktree[activeWorktreeId] : undefined,
  );
  // Project scope has no git/diff — force plain file view.
  const scope: DiffScope = isProject ? "none" : (scopeRaw ?? "none");

  // Separate local/branch scope for the PLAIN tree (diff mode off) — kept in
  // its own store slice so picking "branch" here never flips `scope` (which
  // FilePreviewPane also reads) and switches the Files header into the flat
  // "Changes" list / full-diff-preview mode. That mode toggle stays the sole
  // job of the "Diff view" (GitCompare) button, per Task A.2.
  const treeScopeRaw = useWorkspaceStore((s) =>
    activeWorktreeId ? s.treeScopeByWorktree[activeWorktreeId] : undefined,
  );
  const treeScope: "local" | "branch" = treeScopeRaw ?? "local";

  const [root, setRoot] = useState<TreeEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Hoisted from the old per-node TreeNode: one map of dir path -> its
  // (sorted) children, owned by FileTreeSidebar itself so a flat row list
  // can be derived without a recursive component tree (Decision 2).
  const [childrenByPath, setChildrenByPath] = useState<Map<string, TreeEntry[]>>(new Map());
  const [localChanged, setLocalChanged] = useState<ChangedPathEntry[]>([]);
  const [branchChanged, setBranchChanged] = useState<ChangedPathEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const { lastChanged } = useTreeWatch(api, activeWorktreeId, fileScope);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const diffMode = scope !== "none";
  // Which local/branch scope currently drives the PLAIN tree's per-file
  // status/LOC: the shared `scope` while the flat Changes list is showing
  // (unchanged from before), or the tree's own independent `treeScope` while
  // browsing the plain tree (Task A.4 — new).
  const effectiveTreeScope: "local" | "branch" = diffMode
    ? scope === "branch"
      ? "branch"
      : "local"
    : treeScope;

  // Plain-tree badge/LOC source: local scope keeps today's behavior (the
  // local-only changed-paths fetch); branch scope reflects the diff against
  // the base branch instead, using the same `branchChanged` fetch diff-mode
  // already performs for the flat Changes list (Task A.4) — one endpoint,
  // one fetch, shared by both tree modes.
  const treeSourceEntries = effectiveTreeScope === "branch" ? branchChanged : localChanged;

  const gitStatusByPath = useMemo(() => {
    const m = new Map<string, GitStatusChar>();
    for (const e of treeSourceEntries) {
      m.set(e.path, e.status);
    }
    return m;
  }, [treeSourceEntries]);

  const locByPath = useMemo(() => {
    const m = new Map<string, { insertions?: number; deletions?: number }>();
    for (const e of treeSourceEntries) {
      if (e.insertions !== undefined || e.deletions !== undefined) {
        m.set(e.path, { insertions: e.insertions, deletions: e.deletions });
      }
    }
    return m;
  }, [treeSourceEntries]);

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
      const list = await api.tree(activeWorktreeId, "", fileScope);
      if (!cancelled) setRoot(sortEntries(list));
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeWorktreeId, fileScope, lastChanged]);

  // Switching context (worktree/project or file scope) invalidates any
  // already-loaded children — reset so the "missing from childrenByPath"
  // check below can't serve stale data cached under the old context.
  useEffect(() => {
    setChildrenByPath(new Map());
  }, [activeWorktreeId, fileScope]);

  // Load children for every currently-expanded directory that ISN'T already
  // in childrenByPath. Hoisted out of the old per-node TreeNode component
  // (Decision 2) so a flat row list can be derived in one place instead of a
  // recursive tree of components each owning its own children state.
  //
  // Deliberately keyed on `expanded` only (not `childrenByPath`, which this
  // effect itself writes) plus context — expanding one more directory must
  // fetch exactly that directory, not re-fetch every other already-expanded
  // (already-loaded) one too.
  useEffect(() => {
    if (!activeWorktreeId || expanded.size === 0) return;
    const missing = [...expanded].filter((p) => !childrenByPath.has(p));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        missing.map(async (dirPath) => {
          const list = await api.tree(activeWorktreeId, dirPath, fileScope);
          return [dirPath, sortEntries(list)] as const;
        }),
      );
      if (cancelled) return;
      setChildrenByPath((prev) => {
        const next = new Map(prev);
        for (const [dirPath, list] of results) next.set(dirPath, list);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activeWorktreeId, fileScope, expanded]);

  // Disk state changed (tree watch) — this one SHOULD refetch every
  // currently-expanded directory, since childrenByPath's cached contents may
  // now be stale. Skips the initial mount (the effect above already covers
  // that) so it only fires on an actual `lastChanged` bump.
  const sawFirstLastChanged = useRef(false);
  useEffect(() => {
    if (!sawFirstLastChanged.current) {
      sawFirstLastChanged.current = true;
      return;
    }
    if (!activeWorktreeId || expanded.size === 0) return;
    let cancelled = false;
    const dirs = [...expanded];
    void (async () => {
      const results = await Promise.all(
        dirs.map(async (dirPath) => {
          const list = await api.tree(activeWorktreeId, dirPath, fileScope);
          return [dirPath, sortEntries(list)] as const;
        }),
      );
      if (cancelled) return;
      setChildrenByPath((prev) => {
        const next = new Map(prev);
        for (const [dirPath, list] of results) next.set(dirPath, list);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChanged]);

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
    // Project scope (direct sessions) has no git — skip status entirely.
    if (!activeWorktreeId || isProject) {
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
  }, [api, activeWorktreeId, isProject, lastChanged]);

  useEffect(() => {
    // Fetch whenever EITHER scope source currently needs "branch" data — the
    // flat Changes list's own `scope`, or the plain tree's independent
    // `treeScope` (Task A.4) — so switching either one to "branch" has data
    // ready without a spurious extra fetch when neither wants it.
    if (!activeWorktreeId || isProject || effectiveTreeScope !== "branch") {
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
  }, [api, activeWorktreeId, isProject, effectiveTreeScope, lastChanged]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }

  function openFile(path: string) {
    if (!activeWorktreeId) return;
    setActiveFile(path);
    setToolPanelTab("files");
  }

  const visibleRows = useMemo(() => {
    const out: FlatRow[] = [];
    flattenVisible(root, 0, expanded, childrenByPath, out);
    return out;
  }, [root, expanded, childrenByPath]);

  const { cursorPath, setCursorPath, handleKeyDown, isTabbable } = useRovingListNav(visibleRows, {
    onOpen: (path) => {
      const row = visibleRows.find((r) => r.path === path);
      if (!row) return;
      if (row.type === "dir") toggle(path);
      else openFile(path);
    },
    onToggle: (path) => toggle(path),
    openOnArrow: true,
  });

  // Keep DOM focus following the roving cursor so subsequent key events land
  // on the cursored row without the caller needing to manage focus itself.
  useEffect(() => {
    if (cursorPath) rowRefs.current.get(cursorPath)?.focus();
  }, [cursorPath]);

  function setScope(next: DiffScope) {
    if (activeWorktreeId) setDiffScopeForWorktree(activeWorktreeId, next);
  }

  function toggleDiffMode() {
    if (scope === "none") {
      // Entering diff mode: seed the Changes list's scope FROM the plain
      // tree's current scope, so it opens showing the same local/branch
      // selection the user just had (rather than silently reverting to
      // "local").
      setScope(treeScope);
    } else {
      // Leaving diff mode: mirror the live diff-mode scope back into the
      // plain tree's own slice, so returning to the tree preserves whatever
      // scope was active in the Changes list.
      if (activeWorktreeId) setTreeScopeForWorktree(activeWorktreeId, scope === "branch" ? "branch" : "local");
      setScope("none");
    }
  }

  // Header selector's onChange: routes to whichever store slice is currently
  // "live" — the shared diff `scope` while the flat Changes list is showing
  // (unchanged behavior), or the tree-only `treeScope` while browsing the
  // plain tree, so picking a scope there never flips diff mode on (Task A.2).
  function handleTreeScopeChipChange(next: DiffScope) {
    if (next !== "local" && next !== "branch") return;
    if (diffMode) {
      setScope(next);
    } else if (activeWorktreeId) {
      setTreeScopeForWorktree(activeWorktreeId, next);
    }
  }

  if (!activeWorktreeId) {
    return (
      <div className="pane pane-stack">
        <div className="pane-header pane-header--compact">Files</div>
        <div className="empty-state">Select a worktree to view files</div>
      </div>
    );
  }

  return (
    <div className="pane pane-stack">
      <div className="pane-header pane-header--compact file-tree-sidebar-header">
        <span className="file-tree-sidebar-header__title">{diffMode ? "Changes" : "Files"}</span>
        <div className="file-tree-sidebar-header__tail">
          {/* One scope selector, always visible in the Files header — not
              gated on diff mode — working in both plain-tree and Changes-list
              mode (Task A.2). Git-only; hidden for project (direct-session)
              scope, same as the diff-view toggle below. */}
          {!isProject ? (
            <div className="file-tree-scope-slot">
              <DiffScopeSelector scope={effectiveTreeScope} onChange={handleTreeScopeChipChange} />
            </div>
          ) : null}
          {/* Diff view is git-only; hidden for project (direct-session) scope. */}
          {!isProject ? (
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
          ) : null}
        </div>
      </div>
      <div
        style={{ flex: 1, overflow: "auto", padding: "var(--space-2)" }}
        role={diffMode ? undefined : "tree"}
        aria-label={
          diffMode
            ? undefined
            : (effectiveTreeScope === "branch" ? branchLoading : localLoading)
              ? "Worktree files, git markers loading"
              : "Worktree files"
        }
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onFocusCapture={() => setFocusedPane("file-tree")}
      >
        <div style={{ minWidth: "max-content" }}>
          {!diffMode && (effectiveTreeScope === "branch" ? branchLoading : localLoading) ? (
            <div className="file-tree-git-loading" aria-live="polite">
              Loading git markers…
            </div>
          ) : null}
          {!diffMode && (effectiveTreeScope === "branch" ? branchError : localError) ? (
            <div className="file-tree-git-error" role="alert">
              {effectiveTreeScope === "branch" ? branchError : localError}
            </div>
          ) : null}
          {diffMode ? (
            <ChangedFileList entries={groupedEntries} loading={groupedLoading} error={groupedError} />
          ) : (
            visibleRows.map((row) => {
              const isDir = row.type === "dir";
              const isOpen = expanded.has(row.path);
              const gitRowClass = rowGitModifier(row.path, isDir, gitStatusByPath);
              const fileStatus = !isDir ? gitStatusByPath.get(row.path) : undefined;
              const dirStatus = isDir ? dirAggregateStatus(row.path, gitStatusByPath) : undefined;
              const badgeStatus = fileStatus ?? dirStatus;
              const rowLoc = !isDir ? locByPath.get(row.path) : undefined;
              const isCursor = row.path === cursorPath;
              return (
                <div
                  key={row.path}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.path, el);
                    else rowRefs.current.delete(row.path);
                  }}
                  className={`tree-row${gitRowClass}${isCursor ? " tree-row--cursor" : ""}`}
                  role="treeitem"
                  aria-expanded={isDir ? isOpen : undefined}
                  tabIndex={isTabbable(row.path) ? 0 : -1}
                  data-active={activeFilePath === row.path}
                  data-git-status={badgeStatus ?? undefined}
                  style={{ paddingLeft: `calc(${row.level} * var(--space-4) + var(--space-2))` }}
                  onClick={() => (isDir ? toggle(row.path) : openFile(row.path))}
                  onFocus={() => setCursorPath(row.path)}
                >
                  <span className="tree-row__kind-icon" aria-hidden>
                    {isDir ? (
                      isOpen ? (
                        <FolderOpen size={15} strokeWidth={1.5} fill="currentColor" fillOpacity={0.18} />
                      ) : (
                        <Folder size={15} strokeWidth={1.5} fill="currentColor" fillOpacity={0.18} />
                      )
                    ) : isTextLikeFile(row.name) ? (
                      <FileText size={14} strokeWidth={1.5} />
                    ) : (
                      <File size={14} strokeWidth={1.5} />
                    )}
                  </span>
                  <span className="tree-row__label">{row.name}</span>
                  {!isDir && rowLoc ? (
                    <span className="tree-row__loc" aria-hidden>
                      {rowLoc.insertions ? <span className="vcs-graph__add">+{rowLoc.insertions}</span> : null}
                      {rowLoc.deletions ? <span className="vcs-graph__del">−{rowLoc.deletions}</span> : null}
                    </span>
                  ) : null}
                  {badgeStatus ? (
                    <span className={`tree-row__git-badge tree-row__git-badge--${badgeStatus === "?" ? "U" : badgeStatus}`} aria-hidden>
                      {gitStatusBadgeChar(badgeStatus)}
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
