import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, MoreHorizontal, Trash2 } from "lucide-react";
import {
  useDemoEnv,
  useEventTargets,
  usePortalRoot,
  useViewportWidth,
} from "@/context/DemoEnv";
import { clampPopupPosition } from "@/lib/popupPosition";
import { useBulkWorktrees } from "./useBulkWorktrees";

/** Estimated menu box for the first clamp; the ref re-clamps to the real one. */
const MENU_WIDTH = 180;
const MENU_HEIGHT = 80;

/**
 * The Projects heading's `⋯` trigger + menu (design `Main.dc.html`): same
 * portal/`clampPopupPosition`/outside-click pattern as the sidebar's filter
 * menu. Choosing an item enters select mode for that action.
 *
 * Items are disabled while a bulk job is unfinished — the runner refuses a
 * second job, so offering one would silently do nothing.
 */
export function BulkMenu() {
  const { doc } = useEventTargets();
  const portalRoot = usePortalRoot();
  const envWidth = useViewportWidth();
  const envHeight = useDemoEnv().viewport?.h ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  const job = useBulkWorktrees((s) => s.job);
  const enter = useBulkWorktrees((s) => s.enter);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);

  const busy = job != null && !job.finished;

  useEffect(() => {
    if (!menuRect) return undefined;
    let removeListeners: (() => void) | undefined;
    // Same deferred attach as the other sidebar menus: the opening click would
    // otherwise immediately close it.
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-bulk-menu-panel]") || t.closest("[data-bulk-menu-trigger]")) return;
        setMenuRect(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setMenuRect(null);
      }
      doc.addEventListener("click", onDocClick);
      doc.addEventListener("keydown", onKey);
      removeListeners = () => {
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [menuRect, doc]);

  function choose(action: "archive" | "delete") {
    // Close first: entering select mode swaps the heading and unmounts this menu.
    setMenuRect(null);
    enter(action);
  }

  return (
    <>
      <button
        type="button"
        data-bulk-menu-trigger
        className="icon-btn"
        title="Bulk actions"
        aria-label="Bulk actions"
        aria-haspopup="menu"
        aria-expanded={menuRect != null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuRect((r) => (r ? null : rect));
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {menuRect
        ? (() => {
            const { top, left } = clampPopupPosition(
              menuRect,
              MENU_WIDTH,
              MENU_HEIGHT,
              envWidth,
              envHeight,
            );
            return createPortal(
              <div
                ref={(node) => {
                  if (!node) return;
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    const adjusted = clampPopupPosition(
                      menuRect,
                      rect.width,
                      rect.height,
                      envWidth,
                      envHeight,
                    );
                    node.style.top = `${adjusted.top}px`;
                    node.style.left = `${adjusted.left}px`;
                  }
                }}
                className="menu-pop wt-menu-pop--portal"
                data-bulk-menu-panel
                role="menu"
                aria-label="Bulk actions"
                style={{
                  position: "fixed",
                  top,
                  left,
                  minWidth: MENU_WIDTH,
                  maxHeight: Math.max(80, envHeight - 16),
                  overflowY: "auto",
                  zIndex: 4000,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon"
                  disabled={busy}
                  title={busy ? "A bulk action is running" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    choose("archive");
                  }}
                >
                  <Archive size={13} aria-hidden />
                  Archive worktrees…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-pop__item menu-pop__item--icon menu-pop__item--danger"
                  disabled={busy}
                  title={busy ? "A bulk action is running" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    choose("delete");
                  }}
                >
                  <Trash2 size={13} aria-hidden />
                  Delete worktrees…
                </button>
              </div>,
              portalRoot,
            );
          })()
        : null}
    </>
  );
}
