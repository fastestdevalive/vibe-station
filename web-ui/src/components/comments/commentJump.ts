import type { ReviewComment } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Line a comment sits at now: the re-anchored span when the daemon found one, else the last known span
 * (`lineStart`, or the new-side start for a diff), clamped to the file length when known. An outdated comment
 * therefore opens "where it was" (R59).
 */
export function commentJumpLine(c: ReviewComment, fileLength?: number): number {
  const raw = c.current?.start ?? c.lineStart ?? c.newStart ?? c.oldStart ?? 1;
  const clamped = fileLength != null && fileLength > 0 ? Math.min(raw, fileLength) : raw;
  return Math.max(1, clamped);
}

/**
 * Open a comment's file at its line (the tab opens or focuses; a collapsed diff hunk or context gap expands
 * through `DiffView`'s reveal path). The Phase 6 tray / list rows and the bubble footer call this.
 */
export function jumpToComment(c: ReviewComment, fileLength?: number): void {
  useWorkspaceStore.getState().setActiveFilePathAtLine(c.scopeId, c.path, commentJumpLine(c, fileLength));
}

/** `CSS.escape` with a fallback for environments without it (jsdom). */
export const cssEscape = (s: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");

/**
 * Bring a saved comment's card into view and focus its first action (a pin was pressed). `from` is the pressed pin:
 * the search stays inside its comment surface, so a second tile showing the same file focuses its own card.
 * A stable module function (not a per-line closure) so `memo(CodeLine)` can skip unchanged rows.
 */
export function focusCommentCard(id: string, from?: Element): void {
  const root: ParentNode = from?.closest("[data-comment-surface]") ?? document;
  const card = root.querySelector<HTMLElement>(`[data-comment-card="${cssEscape(id)}"]`);
  card?.scrollIntoView?.({ block: "nearest" });
  card?.querySelector<HTMLElement>("button")?.focus();
}
