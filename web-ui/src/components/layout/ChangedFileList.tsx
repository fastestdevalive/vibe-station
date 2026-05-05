import { File, FileText } from "lucide-react";
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import type { ChangedPathEntry, GitStatusChar } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

interface FlatFile {
  path: string;
  name: string;
  dir: string;
  status: GitStatusChar;
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
  for (const { path, status } of entries) {
    const lastSlash = path.lastIndexOf("/");
    const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
    files.push({ path, name, dir, status });
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

interface ChangedFileListProps {
  entries: ChangedPathEntry[];
  loading?: boolean;
  error?: string | null;
}

export function ChangedFileList({ entries, loading, error }: ChangedFileListProps) {
  const activePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const ensurePaneVisible = useWorkspaceStore((s) => s.ensurePaneVisible);
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent, path: string) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setActiveFile(path);
        ensurePaneVisible(1);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = visibleFiles.findIndex((f) => f.path === path);
        if (idx < 0) return;
        const next = e.key === "ArrowDown" ? visibleFiles[idx + 1] : visibleFiles[idx - 1];
        if (next) setActiveFile(next.path);
      }
    },
    [visibleFiles, setActiveFile, ensurePaneVisible],
  );

  function selectFile(path: string) {
    setActiveFile(path);
    ensurePaneVisible(1);
  }

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
                  return (
                    <div
                      key={file.path}
                      role="treeitem"
                      tabIndex={0}
                      aria-selected={isSelected}
                      aria-label={file.path}
                      className={`changed-file-list-file${isSelected ? " changed-file-list-file--selected" : ""}`}
                      onClick={() => selectFile(file.path)}
                      onKeyDown={(e) => handleKeyDown(e, file.path)}
                    >
                      <span className="changed-file-list-file-icon" aria-hidden>
                        {textLike(file.name) ? (
                          <FileText size={14} strokeWidth={1.5} />
                        ) : (
                          <File size={14} strokeWidth={1.5} />
                        )}
                      </span>
                      <span className="changed-file-list-file-name">{file.name}</span>
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
