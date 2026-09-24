import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, FileScope } from "@/api/types";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useTreeWatch } from "@/hooks/useSubscription";
import { useWorkspaceStore } from "@/hooks/useStore";

interface QuickOpenProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  open: boolean;
  onClose: () => void;
  scope?: FileScope;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

const NO_TABS: string[] = [];
const NO_ROWS: Row[] = [];

const CHANGE_LABEL: Record<string, string> = {
  M: "modified",
  A: "added",
  R: "renamed",
  "?": "new",
};

/** `:` (optionally followed by digits) enters Go-to-line mode. */
const LINE_MODE_RE = /^:\s*(\d*)$/;

interface Row {
  path: string;
  name: string;
  dir: string;
  /** Secondary text shown at the right of the row (line/LOC info). */
  meta?: string;
  isOpen: boolean;
}

function toRow(path: string, isOpen: boolean, meta?: string): Row {
  return {
    path,
    name: basename(path),
    dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    meta,
    isOpen,
  };
}

export function QuickOpen({ api, worktreeId, open, onClose, scope = "worktree" }: QuickOpenProps) {
  const wt = worktreeId ?? "";
  const openTabs = useWorkspaceStore((s) => s.openFileTabsByWorktree[wt] ?? NO_TABS);
  const activeTabIdx = useWorkspaceStore((s) => s.activeFileTabIdxByWorktree[wt]);
  const openFileTabNew = useWorkspaceStore((s) => s.openFileTabNew);
  const setActiveFileTabIdx = useWorkspaceStore((s) => s.setActiveFileTabIdx);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lineCounts, setLineCounts] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestedCounts = useRef(new Set<string>());
  const [changed, setChanged] = useState<ChangedPathEntry[]>([]);

  // Modes are chosen by the first character: `:` → go to line (across open
  // tabs), `>` → commands (placeholder), anything else → filename search.
  // Only filename search hits the server: pass `null` so useFileSearch issues
  // no request in the other modes (Decision 7).
  const lineMatch = LINE_MODE_RE.exec(query);
  const isLineMode = lineMatch !== null;
  const lineTarget = lineMatch && lineMatch[1] ? Number(lineMatch[1]) : null;
  const isCommandMode = query.startsWith(">");
  const effectiveWorktreeId = open && !isLineMode && !isCommandMode ? worktreeId : null;

  const { files, loading, error, truncated } = useFileSearch(
    api,
    effectiveWorktreeId,
    query,
    scope,
  );

  // The daemon's file-search index only stays live (and only survives at
  // all — see FileSearchIndex::evict) while at least one tree:watch is held
  // for this worktree. FileTreeSidebar/FilePreviewPane hold one, but only
  // while the Files tool-panel tab is the active one — Quick Open itself is
  // reachable from the top bar regardless of which tab is showing. Without
  // this, opening Quick Open while on e.g. the VCS tab queries against an
  // index nothing is keeping fresh. `null` while closed lets useTreeWatch's
  // own cleanup (tree:unwatch) run, same as any other consumer's lifecycle.
  useTreeWatch(api, open ? worktreeId : null, scope);

  // Open files, active one first. The active file always counts as open even
  // if the tab list hasn't caught up.
  const activePath = activeFilePath ?? (activeTabIdx != null ? openTabs[activeTabIdx] : undefined) ?? null;
  const orderedOpen = useMemo(
    () => (activePath ? [activePath, ...openTabs.filter((p) => p !== activePath)] : [...openTabs]),
    [activePath, openTabs],
  );

  // Line counts of open files are needed to decide which files can satisfy a
  // line number. Fetch lazily, once per path, only when line mode is entered.
  useEffect(() => {
    if (!open || !isLineMode || !wt) return;
    let cancelled = false;
    for (const path of orderedOpen) {
      if (requestedCounts.current.has(path)) continue;
      requestedCounts.current.add(path);
      api
        .getFile(wt, path, scope)
        .then((text) => {
          if (!cancelled) setLineCounts((c) => ({ ...c, [path]: text.split("\n").length }));
        })
        .catch(() => {
          requestedCounts.current.delete(path); // allow a retry next time
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, isLineMode, wt, orderedOpen, api, scope]);

  // Git-changed files (added/edited/untracked) are surfaced first when no
  // query is typed. Refetched every time the dialog opens.
  useEffect(() => {
    if (!open || !wt) return;
    let cancelled = false;
    setChanged([]);
    api
      .listChangedPaths(wt, "local", undefined, scope)
      .then((entries) => {
        if (!cancelled) setChanged(entries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, wt, scope, api]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setLineCounts({});
      requestedCounts.current.clear();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Empty query: changed files on top (most recently touched first), then
  // the rest of the server's default listing.
  const isEmptyQuery = query.trim() === "";
  const searchRows = useMemo(() => {
    const rows: Row[] = [];
    const seen = new Set<string>();
    if (isEmptyQuery) {
      const recent = changed
        .filter((c) => c.status !== "D")
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
      for (const c of recent) {
        seen.add(c.path);
        rows.push(toRow(c.path, openTabs.includes(c.path), CHANGE_LABEL[c.status] ?? "changed"));
      }
    }
    for (const path of files) {
      if (!seen.has(path)) rows.push(toRow(path, openTabs.includes(path)));
    }
    return rows;
  }, [files, openTabs, changed, isEmptyQuery]);

  // Line-mode rows: the active file is always first (so Enter jumps within
  // the file you're looking at); other open files appear only if they have
  // enough lines for the requested number (once their length is known).
  const lineRows = useMemo(() => {
    const rows: Row[] = [];
    for (const path of orderedOpen) {
      const loc = lineCounts[path];
      const isActive = path === activePath;
      if (lineTarget === null) {
        rows.push(toRow(path, true, loc !== undefined ? `${loc} lines` : undefined));
      } else if (isActive) {
        rows.push(
          toRow(
            path,
            true,
            loc !== undefined && lineTarget > loc
              ? `only ${loc} lines · jumps to end`
              : `line ${lineTarget}`,
          ),
        );
      } else if (loc !== undefined && loc >= lineTarget) {
        rows.push(toRow(path, true, `line ${lineTarget} of ${loc}`));
      }
    }
    return rows;
  }, [orderedOpen, lineCounts, lineTarget, activePath]);

  const rows = useMemo(
    () => (isLineMode ? lineRows : isCommandMode ? NO_ROWS : searchRows),
    [isLineMode, isCommandMode, lineRows, searchRows],
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectFile = useCallback(
    (path: string) => {
      if (!wt) return;
      const existingIdx = openTabs.indexOf(path);
      if (existingIdx >= 0) {
        setActiveFileTabIdx(wt, existingIdx);
      } else {
        openFileTabNew(wt, path);
      }
      setToolPanelTab("files");
      onClose();
    },
    [wt, openTabs, openFileTabNew, setActiveFileTabIdx, setToolPanelTab, onClose],
  );

  const jumpToLine = useCallback(
    (path: string) => {
      if (!wt || lineTarget === null || lineTarget < 1) return;
      const loc = lineCounts[path];
      const line = loc !== undefined ? Math.min(lineTarget, loc) : lineTarget;
      setActiveFilePathAtLine(wt, path, line);
      setToolPanelTab("files");
      onClose();
    },
    [wt, lineTarget, lineCounts, setActiveFilePathAtLine, setToolPanelTab, onClose],
  );

  const activate = useCallback(
    (path: string) => (isLineMode ? jumpToLine(path) : selectFile(path)),
    [isLineMode, jumpToLine, selectFile],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (isCommandMode) break;
          if (rows[selectedIndex]) activate(rows[selectedIndex].path);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [rows, selectedIndex, activate, onClose, isCommandMode],
  );

  const setMode = (prefix: string) => {
    setQuery(prefix);
    inputRef.current?.focus();
  };

  if (!open) return null;

  if (!worktreeId) {
    return (
      <div className="quick-open-overlay" role="dialog" aria-modal aria-labelledby="quick-open-need-session">
        <button type="button" className="quick-open-backdrop" aria-label="Close" onClick={onClose} />
        <div className="quick-open-dialog" style={{ padding: "var(--space-4)" }}>
          <h2 id="quick-open-need-session" className="quick-open-title" style={{ padding: 0, marginBottom: "var(--space-2)" }}>
            Open file
          </h2>
          <p className="quick-open-empty" style={{ padding: 0 }}>
            Select a worktree first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="quick-open-overlay" role="dialog" aria-modal aria-labelledby="quick-open-input">
      <button type="button" className="quick-open-backdrop" aria-label="Close" onClick={onClose} />
      <div className="quick-open-dialog">
        <div className="quick-open-row">
          <span className="quick-open-search-icon" aria-hidden>
            ⌕
          </span>
          {isLineMode ? <span className="quick-open-chip quick-open-chip--line">Go to line</span> : null}
          {isCommandMode ? <span className="quick-open-chip quick-open-chip--cmd">Commands</span> : null}
          <input
            ref={inputRef}
            id="quick-open-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={truncated ? "Search files by name (list truncated)…" : "Search files by name…"}
            className="quick-open-input"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="quick-open-kbd">esc</kbd>
        </div>
        <div ref={listRef} className="quick-open-list">
          {isCommandMode ? (
            <div className="quick-open-empty">No commands yet</div>
          ) : rows.length === 0 ? (
            <div className="quick-open-empty">
              {isLineMode
                ? orderedOpen.length === 0
                  ? "No open files — open a file, then use :line to jump within it"
                  : `No open file has ${lineTarget} lines`
                : error
                  ? error
                  : loading && files.length === 0
                    ? "Loading files…"
                    : "No files found"}
            </div>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.path}
                type="button"
                className={`quick-open-item ${i === selectedIndex ? "quick-open-item--selected" : ""}`}
                onClick={() => activate(row.path)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="quick-open-file-icon" aria-hidden>
                  {isLineMode ? "⌖" : "📄"}
                </span>
                <span className="quick-open-file-name">{row.name}</span>
                {row.dir ? (
                  <span className="quick-open-file-dir" title={row.dir}>
                    {row.dir}
                  </span>
                ) : null}
                {row.meta ? <span className="quick-open-file-meta">{row.meta}</span> : null}
                {!isLineMode && row.isOpen ? (
                  <span className="quick-open-file-open-badge" aria-label="already open">
                    open
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="quick-open-hints" data-testid="quick-open-hints">
          {isLineMode ? (
            <>
              <span className="quick-open-hint">
                <kbd>↵</kbd> jump to line
              </span>
              <span className="quick-open-hint">
                <kbd>↑↓</kbd> choose file
              </span>
            </>
          ) : isCommandMode ? (
            <span className="quick-open-hint">Commands are coming soon</span>
          ) : (
            <>
              <button type="button" className="quick-open-hint quick-open-hint--action" onMouseDown={(e) => e.preventDefault()} onClick={() => setMode(":")}>
                <kbd>:</kbd> go to line in an open file
              </button>
              <button type="button" className="quick-open-hint quick-open-hint--action" onMouseDown={(e) => e.preventDefault()} onClick={() => setMode(">")}>
                <kbd>&gt;</kbd> commands
              </button>
              <span className="quick-open-hint">
                <kbd>↑↓</kbd> navigate
              </span>
              <span className="quick-open-hint">
                <kbd>↵</kbd> open
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
