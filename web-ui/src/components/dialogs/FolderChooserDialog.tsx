import { PathGhost } from "./PathGhost";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import type { ApiInstance } from "@/api";
import { useCompletionKeys } from "./useCompletionKeys";
import { useDirSuggestions } from "@/hooks/useDirSuggestions";
import {
  acceptedPath,
  ghostFor,
  isRoot,
  parentPath,
  sameFolder,
  stripSlash,
  visibleEntries,
  withSlash,
  type FolderEntry,
} from "./folderChooserModel";

interface FolderChooserDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  api: ApiInstance;
  initialPath: string;
}

/**
 * Combobox-style chooser: focus stays in the path field, arrows move a
 * highlight (`aria-activedescendant`), and the typed text is sent verbatim.
 * Navigated paths carry their own trailing `/` (see folderChooserModel).
 */
export function FolderChooserDialog({
  open,
  onClose,
  onSelect,
  api,
  initialPath,
}: FolderChooserDialogProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const {
    suggestions: rawSuggestions,
    listedFor,
    truncated,
    loading,
    error,
    settled,
    scheduleFetch,
    reset,
  } = useDirSuggestions(api);

  const suggestions = visibleEntries(rawSuggestions, currentPath);
  const ghost =
    listedFor !== null && sameFolder(listedFor, currentPath) ? ghostFor(currentPath, rawSuggestions) : null;
  const [ghostIsClipped, setGhostIsClipped] = useState(false);
  const keys = useCompletionKeys({
    entries: suggestions,
    ghostEntry: ghost && !ghostIsClipped ? ghost.entry : null,
    disabled: loading,
    onAccept: (entry) => setCurrentPath(acceptedPath(currentPath, entry)),
    onEnter: (active, e) => {
      e.preventDefault();
      if (active) descend(active);
      else handleSelect();
    },
    onHighlight: (entry) => setSelectedFolder(acceptedPath(currentPath, entry)),
  });
  const { activeIndex, setActiveIndex } = keys;

  // Seed from `initialPath` on the open transition ONLY. Keeping initialPath in
  // the deps would reset the user's navigation mid-browse if the prop changed
  // while open (the parent derives it from its own query / a late-resolving
  // defaultProjectsDir).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCurrentPath(withSlash(initialPath.trim() || "/"));
      setSelectedFolder(null);
      setActiveIndex(-1);
      reset();
    }
    wasOpenRef.current = open;
  }, [open, initialPath, reset]);

  // Load the typed path's children. Debounced via scheduleFetch: the path field
  // changes on every keystroke, and an un-debounced fetch meant one request per
  // character. The path is sent verbatim (no forced trailing slash).
  useEffect(() => {
    if (!open || !currentPath) return;
    scheduleFetch(currentPath);
    setSelectedFolder(null);
    setActiveIndex(-1);
  }, [open, currentPath, scheduleFetch]);

  function resetHighlight() {
    setSelectedFolder(null);
    keys.resetHighlight();
  }

  function descend(entry: FolderEntry) {
    setCurrentPath(acceptedPath(currentPath, entry));
    resetHighlight();
  }

  function navigateUp() {
    if (isRoot(currentPath) || loading) return;
    setCurrentPath(parentPath(currentPath));
    resetHighlight();
  }

  function handleSelect() {
    onSelect(stripSlash(selectedFolder || currentPath));
    onClose();
  }

  function focusInput() {
    inputWrapRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }

  function handleOptionClick(index: number, entry: FolderEntry) {
    setActiveIndex(index);
    setSelectedFolder(acceptedPath(currentPath, entry));
    focusInput();
  }

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0) return;
    const activeEl = document.getElementById(`${listId}-opt-${activeIndex}`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  const optionId = (idx: number) => `${listId}-opt-${idx}`;

  // One status line under the list (also the polite live region): a count when
  // there are rows, otherwise why there are none. A previous list stays visible
  // while a new request is in flight (no "Loading" replacement).
  let statusText = "";
  if (suggestions.length > 0) statusText = `${suggestions.length} ${suggestions.length === 1 ? "folder" : "folders"}`;
  else if (loading && !settled) statusText = "Loading directories...";
  else if (rawSuggestions.length > 0) statusText = "Only hidden folders here — type a dot to show them.";
  else if (settled) statusText = "No matching folders";

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
            disabled={isRoot(currentPath) || loading}
            title="Go to parent directory"
          >
            ↱ Up
          </button>
          <div className="folder-chooser__input-wrap path-ghost-field" ref={inputWrapRef}>
            <Input
              type="text"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls={listId}
              aria-autocomplete="both"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              className="folder-chooser__path-input"
              value={currentPath}
              onChange={(e) => {
                setCurrentPath(e.target.value);
                resetHighlight();
              }}
              onKeyDown={keys.onKeyDown}
              placeholder="Type path..."
            />
            {ghost ? (
              <PathGhost
                getInput={() => inputWrapRef.current?.querySelector("input") ?? null}
                typed={currentPath}
                remainder={ghost.remainder}
                onClippedChange={setGhostIsClipped}
              />
            ) : null}
          </div>
        </div>

        {error && <div className="field-error">{error}</div>}

        <div
          id={listId}
          role="listbox"
          aria-label="Folder list"
          className="folder-chooser__list-container"
        >
          {suggestions.length > 0 ? (
            <div className="folder-chooser__list">
              {suggestions.map((entry, idx) => {
                const isSelected = activeIndex === idx;
                return (
                  <button
                    key={entry.path}
                    id={optionId(idx)}
                    data-index={idx}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    className={`folder-chooser__item${
                      isSelected ? " folder-chooser__item--selected" : ""
                    }`}
                    onClick={() => handleOptionClick(idx, entry)}
                    onDoubleClick={() => descend(entry)}
                  >
                    <span className="folder-chooser__item-icon" aria-hidden>📁</span>
                    <span className="folder-chooser__item-name">{entry.name}</span>
                  </button>
                );
              })}
              {truncated ? (
                <div className="folder-chooser__more" role="presentation">
                  more… keep typing to narrow the list
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="folder-chooser__selection-hint" aria-live="polite">
          {statusText}
        </div>
        <div className="folder-chooser__selection-hint">
          Selected: <code>{stripSlash(selectedFolder || currentPath)}</code>
        </div>
      </div>
    </Dialog>
  );
}
