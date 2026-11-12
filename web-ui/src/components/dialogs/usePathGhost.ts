import { useRef, useState } from "react";
import type { useDirSuggestions } from "@/hooks/useDirSuggestions";
import { acceptedPath, ghostFor, matchingEntries, sameFolder } from "./folderChooserModel";
import { useCompletionKeys } from "./useCompletionKeys";

interface UsePathGhostOptions {
  /** The field's own `useDirSuggestions` instance (it owns fetching). */
  suggestions: ReturnType<typeof useDirSuggestions>;
  /** The input's current value. */
  value: string;
  /** Tab / ArrowRight accepted the ghost; the caller sets the value and refetches. */
  onAccept: (nextValue: string) => void;
}

/**
 * Inline-completion ghost for a plain typed-path input: the ghost shows while
 * the input is focused and the listing is for the current folder; Tab /
 * ArrowRight (caret at the end) accept it, like the account FolderField.
 * Render `<PathGhost getInput={() => inputRef.current} typed={value} remainder={ghost.remainder} onClippedChange={onGhostClipped} />`
 * inside a `.path-ghost-field` wrapper when `ghost` is set.
 */
export function usePathGhost({ suggestions, value, onAccept }: UsePathGhostOptions) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const { listedFor, suggestions: entries } = suggestions;
  const current = listedFor !== null && sameFolder(listedFor, value);
  const ghost = focused && current ? ghostFor(value, matchingEntries(entries, value)) : null;
  // A ghost that is not fully visible is neither drawn nor accepted.
  const [clipped, setClipped] = useState(false);
  const keys = useCompletionKeys({
    entries: [],
    ghostEntry: ghost && !clipped ? ghost.entry : null,
    onAccept: (entry) => onAccept(acceptedPath(value, entry)),
    onEnter: () => {},
  });
  return {
    inputRef,
    ghost,
    /** Pass to `<PathGhost onClippedChange>`. */
    onGhostClipped: setClipped,
    /** Muted note text when the completion fetch failed; null otherwise. */
    error: value.trim() ? suggestions.error : null,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onKeyDown: keys.onKeyDown,
  };
}
