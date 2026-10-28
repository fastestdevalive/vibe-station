import { Copy, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ArtifactRow } from "@/api/types";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { usePortalRoot } from "@/context/DemoEnv";
import { clampPopupPosition } from "@/lib/popupPosition";

export interface MenuAnchor {
  el?: HTMLElement;
  x?: number;
  y?: number;
}

interface ArtifactMenuProps {
  row: ArtifactRow;
  anchor: MenuAnchor;
  /** ≤768 px: a bottom sheet instead of a popover. */
  mobile: boolean;
  onClose: () => void;
  onTogglePin: (row: ArtifactRow) => void;
  onCopyPath: (row: ArtifactRow) => void;
  onRemove: (row: ArtifactRow) => void;
}

const MENU_WIDTH = 190;
const MENU_HEIGHT = 112;

/** Row actions: Pin/Unpin, Copy path, Remove from artifacts (`ArtifactStates.dc.html` frame 5, `Mobile.dc.html` sheet). */
export function ArtifactMenu({ row, anchor, mobile, onClose, onTogglePin, onCopyPath, onRemove }: ArtifactMenuProps) {
  const root = usePortalRoot();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const act = (fn: (r: ArtifactRow) => void) => () => {
    onClose();
    fn(row);
  };

  // Remember who had focus so closing returns it (the row, or the ⋯ button).
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const el = opener.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (mobile) return;
    const r = anchor.el?.getBoundingClientRect();
    const x = anchor.x ?? 0;
    const y = anchor.y ?? 0;
    const rect = r ?? { top: y, bottom: y, left: x, right: x };
    setPos(clampPopupPosition(rect, MENU_WIDTH, MENU_HEIGHT, window.innerWidth, window.innerHeight));
  }, [anchor, mobile]);

  // Focus the first item only once the menu is visible (a hidden element
  // cannot take focus).
  useLayoutEffect(() => {
    if (mobile || !pos) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [mobile, pos]);

  useEffect(() => {
    if (mobile) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Capture-phase backstop: Esc closes only the menu, never the tools pane.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onDocKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onDocKey, true);
    };
  }, [mobile, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      // Focus trap: Tab cycles inside the menu.
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };

  const itemClass = mobile ? "artifacts-menu__item artifacts-menu__item--touch" : "artifacts-menu__item";
  const items = (
    <>
      <button type="button" role="menuitem" className={itemClass} onClick={act(onTogglePin)}>
        {row.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        {row.pinned ? "Unpin" : "Pin"}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={act(onCopyPath)}>
        <Copy size={14} aria-hidden="true" />
        Copy path
      </button>
      <div className="artifacts-menu__sep" role="separator" />
      <button type="button" role="menuitem" className={itemClass} onClick={act(onRemove)}>
        <Trash2 size={14} aria-hidden="true" />
        Remove from artifacts
      </button>
    </>
  );

  if (mobile) {
    return (
      <BottomSheet open onClose={onClose} label="Artifact actions">
        <div ref={ref} role="menu" aria-label="Artifact actions" className="artifacts-menu artifacts-menu--sheet" onKeyDown={onKeyDown}>
          {items}
        </div>
      </BottomSheet>
    );
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Artifact actions"
      className="artifacts-menu"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: MENU_WIDTH, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
    >
      {items}
    </div>,
    root,
  );
}
