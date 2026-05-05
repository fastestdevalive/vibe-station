import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { useWorkspaceStore } from "@/hooks/useStore";

async function collectFiles(
  api: ApiInstance,
  worktreeId: string,
): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];

  async function walk(dir: string) {
    const entries = await api.tree(worktreeId, dir);
    for (const e of entries) {
      if (e.type === "dir") {
        await walk(e.path);
      } else {
        out.push({ path: e.path, name: e.name });
      }
    }
  }

  await walk("");
  return out;
}

interface QuickOpenProps {
  api: ApiInstance;
  worktreeId: string | null;
  open: boolean;
  onClose: () => void;
}

export function QuickOpen({ api, worktreeId, open, onClose }: QuickOpenProps) {
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const ensurePaneVisible = useWorkspaceStore((s) => s.ensurePaneVisible);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allFiles, setAllFiles] = useState<{ path: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !worktreeId) {
      setAllFiles([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const files = await collectFiles(api, worktreeId);
        if (!cancelled) {
          setAllFiles(files);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load files");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, open, worktreeId]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 50);
    const q = query.toLowerCase();
    const scored = allFiles
      .map((f) => {
        const nameMatch = f.name.toLowerCase().indexOf(q);
        const pathMatch = f.path.toLowerCase().indexOf(q);
        const score = nameMatch === 0 ? 3 : nameMatch > 0 ? 2 : pathMatch >= 0 ? 1 : 0;
        return { ...f, score };
      })
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, 50);
  }, [query, allFiles]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectFile = useCallback(
    (path: string) => {
      setActiveFile(path);
      ensurePaneVisible(1);
      onClose();
    },
    [setActiveFile, ensurePaneVisible, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            selectFile(filtered[selectedIndex].path);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, selectFile, onClose],
  );

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
          <input
            ref={inputRef}
            id="quick-open-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name…"
            className="quick-open-input"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="quick-open-kbd">esc</kbd>
        </div>
        <div ref={listRef} className="quick-open-list">
          {filtered.length === 0 && (
            <div className="quick-open-empty">
              {error
                ? error
                : loading && allFiles.length === 0
                  ? "Loading files…"
                  : "No files found"}
            </div>
          )}
          {filtered.map((file, i) => {
            const isSelected = i === selectedIndex;
            const dirPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
            return (
              <button
                key={file.path}
                type="button"
                className={`quick-open-item ${isSelected ? "quick-open-item--selected" : ""}`}
                onClick={() => selectFile(file.path)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="quick-open-file-icon" aria-hidden>
                  📄
                </span>
                <span className="quick-open-file-name">{file.name}</span>
                {dirPath ? (
                  <span className="quick-open-file-dir" title={dirPath}>
                    {dirPath}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
