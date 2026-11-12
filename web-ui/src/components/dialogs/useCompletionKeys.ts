import { useState, type KeyboardEvent } from "react";
import type { FolderEntry } from "./folderChooserModel";

interface CompletionKeysOptions {
  /** The rows currently listed, in display order. */
  entries: FolderEntry[];
  /** The inline completion taken by Tab / ArrowRight when no row is highlighted. */
  ghostEntry: FolderEntry | null;
  /** Arrow keys do nothing while true (e.g. a list is still loading). */
  disabled?: boolean;
  /** Tab / ArrowRight accepted a row or the ghost. */
  onAccept: (entry: FolderEntry) => void;
  /** Enter was pressed; `active` is the highlighted row, if any. The handler owns `preventDefault`. */
  onEnter: (active: FolderEntry | undefined, e: KeyboardEvent<HTMLInputElement>) => void;
  /** The highlight moved to `entry` (never called with null by the hook itself). */
  onHighlight?: (entry: FolderEntry) => void;
}

/**
 * Combobox keyboard model shared by the folder chooser and the inline account
 * folder field: arrows move a wrapping highlight while focus stays in the
 * input; Tab / ArrowRight (caret at the end) accept the highlight or the ghost
 * and only then prevent default, so focus is never trapped.
 */
export function useCompletionKeys({
  entries,
  ghostEntry,
  disabled,
  onAccept,
  onEnter,
  onHighlight,
}: CompletionKeysOptions) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const active: FolderEntry | undefined = entries[activeIndex];

  function resetHighlight() {
    setActiveIndex(-1);
  }

  function move(e: KeyboardEvent, direction: 1 | -1) {
    if (disabled || entries.length === 0) return;
    e.preventDefault();
    const count = entries.length;
    const next = activeIndex < 0 ? (direction === 1 ? 0 : count - 1) : (activeIndex + direction + count) % count;
    setActiveIndex(next);
    const entry = entries[next];
    if (entry) onHighlight?.(entry);
  }

  function accept() {
    const entry = active ?? ghostEntry;
    if (entry) onAccept(entry);
    resetHighlight();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const hasCompletion = !!active || !!ghostEntry;
    switch (e.key) {
      case "ArrowDown":
        move(e, 1);
        break;
      case "ArrowUp":
        move(e, -1);
        break;
      case "Enter":
        onEnter(active, e);
        break;
      case "ArrowRight": {
        const input = e.currentTarget;
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        if (atEnd && hasCompletion) {
          e.preventDefault();
          accept();
        }
        break;
      }
      case "Tab":
        if (hasCompletion && !e.shiftKey) {
          e.preventDefault();
          accept();
        }
        break;
      default:
        break;
    }
  }

  return { activeIndex, active, resetHighlight, setActiveIndex, onKeyDown };
}
