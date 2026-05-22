import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useWorktreeFiles } from "@/hooks/useWorktreeFiles";

interface QuickOpenProps {
  api: ApiInstance;
  worktreeId: string | null;
  open: boolean;
  onClose: () => void;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function QuickOpen({ api, worktreeId, open, onClose }: QuickOpenProps) {
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const ensurePaneVisible = useWorkspaceStore((s) => s.ensurePaneVisible);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Pass `null` when closed so the hook does not open a tree:watch we
  // don't need. The cache still survives in module state across re-opens.
  const { files, loading, error, truncated } = useWorktreeFiles(
    api,
    open ? worktreeId : null,
  );

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
    if (!query.trim()) {
      return files.slice(0, 50).map((path) => ({ path, name: basename(path), score: 0 }));
    }
    const q = query.toLowerCase();
    const scored: { path: string; name: string; score: number }[] = [];
    for (const path of files) {
      const name = basename(path);
      const nameMatch = name.toLowerCase().indexOf(q);
      const pathMatch = path.toLowerCase().indexOf(q);
      const score = nameMatch === 0 ? 3 : nameMatch > 0 ? 2 : pathMatch >= 0 ? 1 : 0;
      if (score > 0) scored.push({ path, name, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, 50);
  }, [query, files]);

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
            placeholder={truncated ? "Search files by name (list truncated)…" : "Search files by name…"}
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
                : loading && files.length === 0
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
