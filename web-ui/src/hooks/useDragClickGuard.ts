import { useCallback, useEffect, useRef } from "react";

/** How long after a drag ends a trailing `click` is still treated as part of
 *  that drag. dnd-kit's own internal suppression window is 50ms; we allow more
 *  headroom because the reorder's re-render (and its optimistic store write)
 *  can delay the browser's `click` dispatch, but keep it short enough that a
 *  deliberate follow-up click by the user is never swallowed. */
const DRAG_CLICK_WINDOW_MS = 250;

/**
 * Suppresses the browser's trailing `click` after a dnd-kit drag-to-reorder.
 *
 * WHY THIS CANNOT BE DONE IN A REACT `onClick` HANDLER
 * ----------------------------------------------------
 * dnd-kit's `PointerSensor` already installs its own `click` listener on
 * `document` in the CAPTURE phase the moment a drag activates (see
 * `handleStart` in @dnd-kit/core), and that listener calls `stopPropagation()`.
 * React 18 attaches its event listeners to the *root container* element, which
 * is a descendant of `document`, so the trailing click is killed before React
 * ever sees it — every React `onClick` on the dragged row is dead code for
 * that event.
 *
 * `stopPropagation()`, however, does NOT cancel the event's DEFAULT ACTION.
 * The sortable sidebar rows are React Router `<Link>`s, i.e. real `<a href>`
 * elements, so the browser happily performed the anchor's default navigation —
 * a full document load to the dragged row's URL. That is the actual bug:
 * drag-reordering a worktree navigated to (and therefore selected) it, with no
 * React handler ever running and no way for one to intervene.
 *
 * It only reproduced when the pointer came to rest inside the dragged row's
 * final bounds, because a `click` is only dispatched at all when the mousedown
 * and mouseup targets are the same element; land on a neighbouring row and the
 * click retargets to a common ancestor `<div>`, which has no default action.
 *
 * THE FIX: listen on `window` in the capture phase. `window` is the first node
 * in the event's propagation path, so this listener runs before dnd-kit's
 * `document`-capture one regardless of registration order, and can call
 * `preventDefault()` (killing the anchor navigation) as well as
 * `stopPropagation()` (so no row handler runs either).
 *
 * WHY A TIMESTAMP AND NOT A BOOLEAN FLAG
 * --------------------------------------
 * A "drag occurred" boolean consumed by the row's click handler goes stale:
 * as shown above the trailing click usually never reaches any React handler,
 * so nothing ever consumed the flag, and it stayed `true` forever — swallowing
 * the *next* genuine click on any row in the list. A timestamp expires on its
 * own, so a missing trailing click cannot poison later clicks.
 */
export function useDragClickGuard(): () => void {
  const draggedAtRef = useRef(0);

  const markDrag = useCallback(() => {
    draggedAtRef.current = performance.now();
  }, []);

  const consumeDragClick = useCallback(() => {
    if (draggedAtRef.current === 0) return false;
    if (performance.now() - draggedAtRef.current > DRAG_CLICK_WINDOW_MS) {
      draggedAtRef.current = 0;
      return false;
    }
    draggedAtRef.current = 0;
    return true;
  }, []);

  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (!consumeDragClick()) return;
      // preventDefault kills the <a href> navigation the browser would
      // otherwise perform; stopPropagation keeps the click from reaching any
      // row handler further down the path.
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("click", onClickCapture, true);
    return () => window.removeEventListener("click", onClickCapture, true);
  }, [consumeDragClick]);

  /** Wire into every `DndContext`'s `onDragStart`, `onDragEnd` AND
   *  `onDragCancel`. Marking on end (not just start) is what matters: the
   *  suppression window has to be measured from the drop, since a drag can
   *  last far longer than the window itself. */
  return markDrag;
}
