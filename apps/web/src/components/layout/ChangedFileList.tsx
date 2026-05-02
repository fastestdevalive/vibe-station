import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
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
    if (existing) {
      existing.push(file);
    } else {
      groupMap.set(file.dir, [file]);
    }
  }
  return [...groupMap.entries()].map(([dir, groupFiles]) => ({ dir, files: groupFiles }));
}

interface ChangedFileListProps {
  entries: ChangedPathEntry[];
  loading?: boolean;
  error?: string | null;
}

export function ChangedFileList({ entries, loading, error }: ChangedFileListProps) {
  const activePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const flatFiles = flattenChanged(entries);
  const groups = groupFiles(flatFiles);

  const toggleDir = useCallback((dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

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
      {groups.map((g) => (
        <div key={g.dir || "__root__"}>
          {g.dir ? (
            <button
              type="button"
              className="changed-file-list__dir"
              onClick={() => toggleDir(g.dir)}
            >
              <span className="changed-file-list__chev" aria-hidden>
                {collapsedDirs.has(g.dir) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </span>
              <span>{g.dir || "/"}</span>
            </button>
          ) : null}
          {!g.dir || !collapsedDirs.has(g.dir)
            ? g.files.map((f) => (
                <div
                  key={f.path}
                  className="tree-row changed-file-list__row"
                  role="treeitem"
                  data-active={activePath === f.path}
                  tabIndex={0}
                  onClick={() => setActiveFile(f.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveFile(f.path);
                    }
                  }}
                >
                  <span className="changed-file-list__status" title={f.status}>
                    {statusLabel(f.status)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{f.name}</span>
                </div>
              ))
            : null}
        </div>
      ))}
    </div>
  );
}
