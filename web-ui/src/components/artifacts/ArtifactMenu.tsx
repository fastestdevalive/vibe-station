import { Copy, Info, Pin, PinOff, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ArtifactRow } from "@/api/types";
import { ArtifactPopover } from "./ArtifactPopover";

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
  /** The list pane: the menu closes when it is hidden. */
  paneRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onTogglePin: (row: ArtifactRow) => void;
  onCopyPath: (row: ArtifactRow) => void;
  /** Opens the Details popup for this artifact (tools-pane-rework B6.3). */
  onDetails: (row: ArtifactRow) => void;
  onRemove: (row: ArtifactRow) => void;
}

const MENU_WIDTH = 190;
const MENU_HEIGHT = 140;

/** Row actions: Pin/Unpin, Copy path, Remove from artifacts (`ArtifactStates.dc.html` frame 5, `Mobile.dc.html` sheet). */
export function ArtifactMenu({ row, anchor, mobile, paneRef, onClose, onTogglePin, onCopyPath, onDetails, onRemove }: ArtifactMenuProps) {
  const opener = useRef<HTMLElement | null>(null);

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

  const anchorRect = () => {
    const r = anchor.el?.getBoundingClientRect();
    const x = anchor.x ?? 0;
    const y = anchor.y ?? 0;
    return r ?? { top: y, bottom: y, left: x, right: x };
  };

  const itemClass = mobile ? "artifacts-menu__item artifacts-menu__item--touch" : "artifacts-menu__item";
  return (
    <ArtifactPopover label="Artifact actions" mobile={mobile} width={MENU_WIDTH} height={MENU_HEIGHT} anchorRect={anchorRect} watchRef={paneRef} onClose={onClose}>
      <button type="button" role="menuitem" className={itemClass} onClick={act(onTogglePin)}>
        {row.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        {row.pinned ? "Unpin" : "Pin"}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={act(onCopyPath)}>
        <Copy size={14} aria-hidden="true" />
        Copy path
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={act(onDetails)}>
        <Info size={14} aria-hidden="true" />
        Details
      </button>
      <div className="artifacts-menu__sep" role="separator" />
      <button type="button" role="menuitem" className={itemClass} onClick={act(onRemove)}>
        <Trash2 size={14} aria-hidden="true" />
        Remove from artifacts
      </button>
    </ArtifactPopover>
  );
}
