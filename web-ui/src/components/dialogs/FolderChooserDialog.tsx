import { useEffect, useState, useRef } from "react";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import type { ApiInstance } from "@/api";
import { useDirSuggestions } from "@/hooks/useDirSuggestions";

interface FolderChooserDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  api: ApiInstance;
  initialPath: string;
}

export function FolderChooserDialog({
  open,
  onClose,
  onSelect,
  api,
  initialPath,
}: FolderChooserDialogProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    suggestions: rawSuggestions,
    truncated,
    loading,
    error,
    scheduleFetch,
    reset,
  } = useDirSuggestions(api);

  // Filter out hidden (dot) folders by default, unless the user explicitly types a dot prefix
  const suggestions = rawSuggestions.filter((entry) => {
    if (entry.name.startsWith(".")) {
      // If path query ends with dot, show hidden folders starting with dot
      const lastPart = currentPath.split("/").pop() || "";
      return lastPart.startsWith(".");
    }
    return true;
  });

  // Seed from `initialPath` on the open transition ONLY. Keeping initialPath in
  // the deps would reset the user's navigation mid-browse if the prop changed
  // while open (the parent derives it from its own query / a late-resolving
  // defaultProjectsDir).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCurrentPath(initialPath.trim() || "/");
      setSelectedFolder(null);
      setActiveIndex(-1);
      reset();
    }
    wasOpenRef.current = open;
  }, [open, initialPath, reset]);

  // Load directories. Debounced via scheduleFetch: `currentPath` changes on
  // every keystroke in the path field, and an un-debounced fetch here meant one
  // HTTP request (and one `git` spawn on the /fs/check side) per character.
  useEffect(() => {
    if (!open || !currentPath) return;

    // fsComplete lists children only when the path ends with a separator.
    // Collapse repeated slashes so "/" + "/" can't produce "//".
    const pathForList = `${currentPath}/`.replace(/\/+/g, "/");

    scheduleFetch(pathForList);
    setSelectedFolder(null);
    setActiveIndex(-1);
  }, [open, currentPath, scheduleFetch]);

  function handleFolderClick(index: number, path: string) {
    setSelectedFolder(path);
    setActiveIndex(index);
  }

  function handleFolderDoubleClick(path: string) {
    setCurrentPath(path);
    setSelectedFolder(null);
    setActiveIndex(-1);
  }

  function navigateUp() {
    if (!currentPath || currentPath === "/") return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    setCurrentPath(parent);
    setSelectedFolder(null);
    setActiveIndex(-1);
  }

  function handleSelect() {
    const finalPath = selectedFolder || currentPath;
    onSelect(finalPath);
    onClose();
  }

  /**
   * Hand off from the path field into the list on a vertical arrow. Replaces an
   * effect that used to focus the list whenever results arrived — because that
   * effect re-ran after every fetch, and the fetch is triggered by typing in
   * this very field, it stole focus mid-word: typing a path only ever recorded
   * its first character. Left/Right/Backspace deliberately stay as ordinary
   * text editing here (the list binds them to navigate/descend).
   */
  function handlePathInputKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (loading || suggestions.length === 0) return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? 0 : suggestions.length - 1;
    setActiveIndex(next);
    const entry = suggestions[next];
    if (entry) setSelectedFolder(entry.path);
    containerRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (loading || suggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev + 1 >= suggestions.length ? 0 : prev + 1;
          const entry = suggestions[next];
          if (entry) setSelectedFolder(entry.path);
          return next;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev - 1 < 0 ? suggestions.length - 1 : prev - 1;
          const entry = suggestions[next];
          if (entry) setSelectedFolder(entry.path);
          return next;
        });
        break;
      case "Enter":
      case "ArrowRight":
        e.preventDefault();
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          handleFolderDoubleClick(suggestions[activeIndex]!.path);
        } else {
          handleSelect();
        }
        break;
      case "Backspace":
      case "ArrowLeft":
        e.preventDefault();
        navigateUp();
        break;
      default:
        break;
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && containerRef.current) {
      const activeEl = containerRef.current.querySelector(
        `[data-index="${activeIndex}"]`
      ) as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [activeIndex]);

  return (
    <Dialog
      open={open}
      title="Choose Directory"
      onClose={onClose}
      overlayClassName="dialog-overlay--nested"
      cardClassName="dialog-card--folder-chooser"
      footer={
        <div className="dialog-actions">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSelect}
            disabled={loading}
          >
            Select Folder
          </button>
        </div>
      }
    >
      <div className="folder-chooser">
        <div className="folder-chooser__nav">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={navigateUp}
            disabled={currentPath === "/" || loading}
            title="Go to parent directory"
          >
            ↱ Up
          </button>
          <Input
            type="text"
            className="folder-chooser__path-input"
            value={currentPath}
            onChange={(e) => {
              setCurrentPath(e.target.value);
              setSelectedFolder(null);
              setActiveIndex(-1);
            }}
            onKeyDown={handlePathInputKeyDown}
            placeholder="Type path..."
          />
        </div>

        {error && <div className="field-error">{error}</div>}

        <div
          ref={containerRef}
          tabIndex={0}
          className="folder-chooser__list-container"
          onKeyDown={handleKeyDown}
          aria-label="Folder list"
          role="listbox"
          aria-activedescendant={
            activeIndex >= 0 ? `folder-opt-${activeIndex}` : undefined
          }
        >
          {loading ? (
            <div className="folder-chooser__status">Loading directories...</div>
          ) : suggestions.length === 0 ? (
            <div className="folder-chooser__status">
              {rawSuggestions.length > 0
                ? "Only hidden folders here — type a dot to show them."
                : "No sub-directories here."}
            </div>
          ) : (
            <div className="folder-chooser__list">
              {suggestions.map((entry, idx) => {
                const isSelected = selectedFolder === entry.path || activeIndex === idx;
                return (
                  <button
                    key={entry.path}
                    id={`folder-opt-${idx}`}
                    data-index={idx}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    className={`folder-chooser__item${
                      isSelected ? " folder-chooser__item--selected" : ""
                    }`}
                    onClick={() => handleFolderClick(idx, entry.path)}
                    onDoubleClick={() => handleFolderDoubleClick(entry.path)}
                  >
                    <span className="folder-chooser__item-icon" aria-hidden>📁</span>
                    <span className="folder-chooser__item-name">{entry.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {/* Gate on the visible count too: hiding dot-folders can leave a short
            list, and a "showing the first 50" note over three rows reads as a
            bug rather than a cap. */}
        {truncated && suggestions.length > 0 ? (
          <div className="folder-chooser__truncated-hint">
            Showing the first 50 folders — type more of the name to narrow the list.
          </div>
        ) : null}
        <div className="folder-chooser__selection-hint">
          Selected: <code>{selectedFolder || currentPath}</code>
        </div>
      </div>
    </Dialog>
  );
}
