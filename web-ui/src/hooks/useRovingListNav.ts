import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** One flat, navigable row. Trees flatten to this shape too — `expandable`
 *  is what lets a single hook serve both a tree (FileTreeSidebar) and an
 *  already-flat list (ChangedFileList) without branching on "am I a tree"
 *  inside the hook (Decision 2). */
export interface RovingRow {
  path: string;
  expandable?: boolean;
}

export interface UseRovingListNavOptions {
  /** Called with the current cursor path on Enter. */
  onOpen: (path: string) => void;
  /** Called on ArrowRight/ArrowLeft for a row with `expandable: true`. */
  onToggle?: (path: string) => void;
}

export interface UseRovingListNavResult {
  cursorPath: string | null;
  setCursorPath: (path: string | null) => void;
  handleKeyDown: (e: ReactKeyboardEvent) => void;
  /**
   * Roving-tabindex convention: exactly one row is always tabbable. Before a
   * cursor exists (nothing clicked/focused yet), row[0] is the tabbable
   * fallback so the list stays reachable via Tab alone — without this, every
   * row renders `tabIndex={-1}` until the user clicks one, which would be a
   * keyboard-navigation regression.
   */
  isTabbable: (path: string) => boolean;
}

/**
 * Shared roving-cursor keyboard navigation for a flat row list (Decision 2).
 * ArrowUp/ArrowDown move the cursor without wrapping past either end;
 * ArrowLeft/ArrowRight call `onToggle` only for rows marked `expandable`;
 * Enter calls `onOpen` with the current cursor.
 */
export function useRovingListNav(
  rows: RovingRow[],
  opts: UseRovingListNavOptions,
): UseRovingListNavResult {
  const [cursorPath, setCursorPath] = useState<string | null>(null);

  function handleKeyDown(e: ReactKeyboardEvent) {
    const idx = rows.findIndex((r) => r.path === cursorPath);
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = idx < 0 ? rows[0] : rows[idx + 1];
        if (next) setCursorPath(next.path);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = idx < 0 ? rows[0] : rows[idx - 1];
        if (prev) setCursorPath(prev.path);
        break;
      }
      case "ArrowRight":
      case "ArrowLeft": {
        if (idx >= 0 && rows[idx]?.expandable) {
          e.preventDefault();
          opts.onToggle?.(rows[idx]!.path);
        }
        break;
      }
      case "Enter":
      case " ": {
        // Space mirrors Enter (restores ChangedFileList's pre-refactor
        // Space-to-open convention) — both call onOpen with the current
        // cursor, falling back to row[0] when nothing has been clicked yet
        // (keeps Space/Enter working the moment focus lands via Tab).
        const openPath = cursorPath ?? rows[0]?.path ?? null;
        if (openPath != null) {
          e.preventDefault();
          opts.onOpen(openPath);
        }
        break;
      }
      default:
        break;
    }
  }

  function isTabbable(path: string): boolean {
    if (cursorPath != null) return path === cursorPath;
    return rows[0]?.path === path;
  }

  return { cursorPath, setCursorPath, handleKeyDown, isTabbable };
}
