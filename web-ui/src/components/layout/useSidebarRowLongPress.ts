import { useIsTouch } from "@/hooks/useIsTouch";
import { useLongPress } from "@/hooks/useLongPress";

/** The "..." triggers on worktree / session / project rows. */
const MENU_TRIGGER_SELECTOR =
  "[data-wt-menu-trigger], [data-sess-menu-trigger], [data-proj-menu-trigger]";

/**
 * Touch devices hide the row "..." buttons (CSS, via `left-sidebar--touch`)
 * and open the same menu on long-press of the row instead. One delegated
 * handler on the sidebar scroll container: it finds the pressed row's own
 * trigger and clicks it, so the existing per-row menu state, anchoring (the
 * trigger stays laid out, just invisible) and outside-click handling are
 * reused as-is. Rows without a trigger (drafts, group headers) are ignored,
 * so a long press there behaves as before.
 */
export function useSidebarRowLongPress() {
  const isTouch = useIsTouch();
  const handlers = useLongPress({
    enabled: isTouch,
    onLongPress: (target) => {
      if (target.closest("input, textarea")) return false;
      const trigger = target
        .closest(".tree-row")
        ?.querySelector<HTMLElement>(MENU_TRIGGER_SELECTOR);
      if (!trigger) return false;
      // Already open for this row: leave it open (click would toggle it shut).
      if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      return true;
    },
  });
  return { isTouch, handlers };
}
