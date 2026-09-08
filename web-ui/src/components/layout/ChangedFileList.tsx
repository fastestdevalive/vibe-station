import { File, FileText } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ChangedPathEntry, GitStatusChar } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useRovingListNav } from "@/hooks/useRovingListNav";

interface FlatFile {
  path: string;
  name: string;
  dir: string;
  status: GitStatusChar;
  insertions?: number;
  deletions?: number;
}

interface Group {
  dir: string;
  files: FlatFile[];
}

function statusLabel(status: GitStatusChar): string {
  switch (status) {
    case "A":
    case "?":
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

function flattenChanged(entries: ChangedPathEntry[]): FlatFile[] {
  const files: FlatFile[] = [];
  for (const { path, status, insertions, deletions } of entries) {
    const lastSlash = path.lastIndexOf("/");
    const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
    files.push({ path, name, dir, status, insertions, deletions });
  }
  files.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir.localeCompare(b.dir);
    return a.name.localeCompare(b.name);
  });
  return files;
}

function groupFiles(files: FlatFile[]): Group[] {
  const groupMap = new Map<string, FlatFile[]>();
  for (const file of files) {
    const existing = groupMap.get(file.dir);
    if (existing) existing.push(file);
    else groupMap.set(file.dir, [file]);
  }
  return [...groupMap.entries()].map(([dir, groupFilesInner]) => ({ dir, files: groupFilesInner }));
}

function textLike(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "json", "yaml", "yml", "ts", "tsx", "js", "jsx", "css", "html", "py", "go", "rs"].includes(ext);
}

/** Decision 6 — bypasses the global `activeFilePath` store slice so a caller
 *  outside the Files tab (the VCS commit view) doesn't steal focus from /
 *  clobber whatever file the Files tab has open. */
export interface ChangedFileListControlled {
  activePath: string | null;
  onSelect: (path: string) => void;
}

interface ChangedFileListProps {
  entries: ChangedPathEntry[];
  loading?: boolean;
  error?: string | null;
  /** When set, clicking/keying a row calls `onSelect` instead of
   *  `setActiveFile`/`setToolPanelTab` (Decision 6). */
  controlled?: ChangedFileListControlled;
}

export function ChangedFileList({ entries, loading, error, controlled }: ChangedFileListProps) {
  const activePathFromStore = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const activePath = controlled ? controlled.activePath : activePathFromStore;
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const flatFiles = useMemo(() => flattenChanged(entries), [entries]);
  const groups = useMemo(() => groupFiles(flatFiles), [flatFiles]);

  const visibleFiles = useMemo(
    () => groups.flatMap((g) => (collapsedDirs.has(g.dir) ? [] : g.files)),
    [groups, collapsedDirs],
  );

  const toggleDir = useCallback((dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  function selectFile(path: string) {
    if (controlled) {
      controlled.onSelect(path);
      return;
    }
    setActiveFile(path);
    setToolPanelTab("files");
  }

  // Shared roving-cursor keyboard nav (Decision 2) — every row here is a
  // plain file (never expandable), so ArrowLeft/ArrowRight are no-ops.
  const rovingRows = useMemo(
    () => visibleFiles.map((f) => ({ path: f.path })),
    [visibleFiles],
  );
  const { cursorPath, setCursorPath, handleKeyDown, isTabbable } = useRovingListNav(rovingRows, {
    onOpen: selectFile,
  });

  if (error) {
    return <div className="changed-file-list-empty">Error: {error}</div>;
  }

  if (loading && flatFiles.length === 0) {
    return <div className="changed-file-list-empty">Loading changes…</div>;
  }

  if (flatFiles.length === 0) {
    return <div className="changed-file-list-empty">No changed files</div>;
  }

  return (
    <div className="changed-file-list" role="tree" aria-label="Changed files">
      {groups.map((group) => {
        const isCollapsed = collapsedDirs.has(group.dir);
        const dirLabel = group.dir || "(root)";
        return (
          <div key={group.dir || "__root__"} role="group">
            <button
              type="button"
              className="changed-file-list-dir-header"
              onClick={() => toggleDir(group.dir)}
              aria-expanded={!isCollapsed}
              title={dirLabel}
            >
              <span className="changed-file-list-dir-chevron" aria-hidden>
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span className="changed-file-list-dir-name">{dirLabel}</span>
              <span className="changed-file-list-dir-count">{group.files.length}</span>
            </button>
            {!isCollapsed && (
              <div>
                {group.files.map((file) => {
                  const isSelected = activePath === file.path;
                  const isCursor = file.path === cursorPath;
                  return (
                    <div
                      key={file.path}
                      role="treeitem"
                      tabIndex={isTabbable(file.path) ? 0 : -1}
                      aria-selected={isSelected}
                      aria-label={file.path}
                      className={`changed-file-list-file${isSelected ? " changed-file-list-file--selected" : ""}${isCursor ? " changed-file-list-file--cursor" : ""}`}
                      onClick={() => selectFile(file.path)}
                      onFocus={() => setCursorPath(file.path)}
                      onKeyDown={handleKeyDown}
                    >
                      <span className="changed-file-list-file-icon" aria-hidden>
                        {textLike(file.name) ? (
                          <FileText size={14} strokeWidth={1.5} />
                        ) : (
                          <File size={14} strokeWidth={1.5} />
                        )}
                      </span>
                      <span className="changed-file-list-file-name">{file.name}</span>
                      {file.insertions !== undefined || file.deletions !== undefined ? (
                        <span className="changed-file-list-file__loc" aria-hidden>
                          {file.insertions ? <span className="vcs-graph__add">+{file.insertions}</span> : null}
                          {file.deletions ? <span className="vcs-graph__del">−{file.deletions}</span> : null}
                        </span>
                      ) : null}
                      <span
                        className={`changed-file-list-file-status changed-file-list-file-status--${file.status === "?" ? "A" : file.status}`}
                        aria-label={`status: ${file.status}`}
                      >
                        {statusLabel(file.status)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
