import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { usePortalRoot } from "@/context/DemoEnv";
import { clampPopupPosition, type RectLike } from "@/lib/popupPosition";

interface ArtifactPopoverProps {
  /** Accessible name of the menu (and of the sheet on phones). */
  label: string;
  /** ≤768 px: a bottom sheet instead of a popover. */
  mobile: boolean;
  /** Extra class on the desktop menu. */
  className?: string;
  width: number;
  /** Expected height, used to keep the popover on screen. */
  height: number;
  maxHeight?: number;
  /** Viewport rect the popover hangs from (right edges align); read at layout time. */
  anchorRect: () => RectLike;
  /** The element that opened it: a pointerdown there is not "outside" (it toggles the popover itself). */
  triggerRef?: RefObject<HTMLElement | null>;
  /** The popover closes when this element leaves the viewport (pane hidden, collapsed or switched). */
  watchRef: RefObject<HTMLElement | null>;
  /** `refocus`: Escape / sheet dismissal (return focus to the opener) vs an outside click or a hidden pane. */
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

/**
 * The artifacts tab's one popover shell (row menu, agent picker): portaled and clamped on screen, hidden until
 * positioned, arrow/Home/End navigation with Tab trapped inside, outside pointerdown and capture-phase Escape close
 * it, and a bottom sheet on phones. Mount it only while open.
 */
export function ArtifactPopover({ label, mobile, className, width, height, maxHeight, anchorRect, triggerRef, watchRef, onClose, children }: ArtifactPopoverProps) {
  const root = usePortalRoot();
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Re-placed after every render (the anchor can move while open); the equality guard stops the update loop.
  useLayoutEffect(() => {
    if (mobile) return;
    const rect = anchorRect();
    const next = clampPopupPosition(rect, width, height, window.innerWidth, window.innerHeight);
    setPos((p) => {
      // A zero-size anchor is detached / not laid out: keep the last good position once there is one.
      if (p && rect.right - rect.left === 0 && rect.bottom - rect.top === 0) return p;
      return p && p.top === next.top && p.left === next.left ? p : next;
    });
  });

  // Focus the checked (else first) item once the menu is visible: a hidden element cannot take focus. Phones skip
  // it: the sheet focuses itself afterwards, so an item focused here would be pulled straight back out.
  useLayoutEffect(() => {
    if (mobile || !pos || focused.current) return;
    focused.current = true;
    const items = menuItems(ref.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [mobile, pos]);

  useEffect(() => {
    if (mobile) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || triggerRef?.current?.contains(t)) return;
      onCloseRef.current(false);
    };
    // Capture-phase backstop: Esc closes only the popover, never the tools pane.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onDocKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onDocKey, true);
    };
  }, [mobile, triggerRef]);

  // The portaled popover must never outlive a hidden list.
  useEffect(() => {
    const el = watchRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last && !last.isIntersecting) onCloseRef.current(false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [watchRef]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = menuItems(ref.current);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    // Focus trap: Tab cycles inside the menu.
    else if (e.key === "Tab") move(i + (e.shiftKey ? -1 : 1));
    // Escape never gets here: the desktop document capture handler and BottomSheet's own capture listener take it.
  };

  if (mobile) {
    return (
      <BottomSheet open onClose={() => onClose(true)} label={label}>
        <div ref={ref} role="menu" aria-label={label} className="artifacts-menu artifacts-menu--sheet" onKeyDown={onKeyDown}>
          {children}
        </div>
      </BottomSheet>
    );
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={className ? `artifacts-menu ${className}` : "artifacts-menu"}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width, maxHeight, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    root,
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
}
