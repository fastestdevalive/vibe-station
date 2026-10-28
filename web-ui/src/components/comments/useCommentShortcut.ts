import { useEffect, useRef } from "react";

/** Targets where a bare `c` is typing, a terminal key or a menu key, never a comment shortcut (Decision 14). */
const BLOCKED = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  ".xterm",
  ".chat-composer",
  ".lexical",
  "[role='dialog']",
  "[role='menu']",
].join(",");

export interface CommentShortcutHandlers {
  /** A selection inside the surface: open the comment box for it. Returns true when it did. */
  onSelection: () => boolean;
  /** Focus is on a gutter `+`: open the box for that row. */
  onPlus: (plus: HTMLElement) => boolean;
}

/** Pure guard so the key matrix is testable without a DOM-wide listener. */
export function isCommentKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  if (e.key !== "c" && e.key !== "C") return false;
  // `C` can arrive from Caps Lock (no shift); any modifier chord, Shift+C included, is something else.
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

/**
 * The `c` shortcut: a LOCAL guarded `document` keydown listener (the global shortcut hook lets xterm's helper
 * textarea through on purpose, so a bare key needs its own guards). Fires only when the key is a plain `c`,
 * the target is not an editable / terminal / composer / dialog / menu, and either focus is on a gutter `+` or
 * the selection sits inside `[data-comment-surface]`. Mounted once per `CommentSurfaceProvider`.
 */
export function useCommentShortcut(enabled: boolean, handlers: CommentShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isCommentKey(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      const plus = target?.closest<HTMLElement>("[data-comment-plus]") ?? null;
      if (!plus && target?.closest(BLOCKED)) return;
      if (plus && target?.closest(".xterm,.chat-composer,.lexical,[role='dialog'],[role='menu']")) return;
      let handled = false;
      if (plus) {
        handled = ref.current.onPlus(plus);
      } else {
        const sel = document.getSelection();
        const node = sel && !sel.isCollapsed ? sel.anchorNode : null;
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        if (!el?.closest("[data-comment-surface]")) return;
        handled = ref.current.onSelection();
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        // Sibling providers (other tools tiles) listen on `document` too: the key is spent.
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
