import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ArtifactPopover } from "@/components/artifacts/ArtifactPopover";
import { useIsMobile } from "@/hooks/useIsMobile";

/** Height of one menu row (plus padding) used to keep the popover on screen. */
const ITEM_H = 30;

export interface RailMenuProps {
  /** Accessible name of the trigger and of the menu. */
  label: string;
  /** `icon`: the sliders "View options" button. `text`: a text dropdown showing `text` with a chevron. */
  variant: "icon" | "text";
  /** Visible text of a `text` trigger. */
  text?: string;
  /** Glyph of an `icon` trigger (default: the sliders). */
  icon?: ReactNode;
  /** Number of menu rows, used to size the popover. */
  itemCount: number;
  width?: number;
  /** Menu rows (`role="menuitem"` / `role="menuitemradio"`); `close(refocus)` dismisses after a pick. */
  children: (close: (refocus: boolean) => void) => ReactNode;
}

/**
 * A header's own menu: an icon or text trigger that opens an `ArtifactPopover` (a bottom sheet on phones).
 * The text variant left-aligns its menu with the trigger; the icon variant right-aligns it.
 */
export function RailMenu({ label, variant, text, icon, itemCount, width = 200, children }: RailMenuProps) {
  const mobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const anchorRect = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return { top: 0, bottom: 0, left: 0, right: width };
    return variant === "text"
      ? { top: r.top, bottom: r.bottom, left: r.left, right: r.left + width }
      : { top: r.top, bottom: r.bottom, left: r.right - width, right: r.right };
  };

  const toggle = () => (open ? close(false) : setOpen(true));

  return (
    <>
      {variant === "icon" ? (
        <button
          ref={triggerRef}
          type="button"
          className="rail-header__ib"
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          {icon ?? <SlidersHorizontal size={14} aria-hidden="true" />}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="rail-header__txt"
          aria-label={label}
          title={text ? `${label}: ${text}` : label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="rail-header__txt-label">{text}</span>
          <ChevronDown size={12} aria-hidden="true" className="rail-header__chev" />
        </button>
      )}
      {open ? (
        <ArtifactPopover
          label={label}
          mobile={mobile}
          className="rail-menu"
          width={width}
          height={itemCount * ITEM_H + 8}
          anchorRect={anchorRect}
          triggerRef={triggerRef}
          watchRef={triggerRef}
          onClose={close}
        >
          {children(close)}
        </ArtifactPopover>
      ) : null}
    </>
  );
}

/** The header's sliders menu: sort, refresh now, limits. Never a "..." glyph (that stays unique to the chip). */
export function ViewOptionsMenu({ itemCount, children }: { itemCount: number; children: (close: (refocus: boolean) => void) => ReactNode }) {
  return (
    <RailMenu label="View options" variant="icon" itemCount={itemCount} width={200}>
      {children}
    </RailMenu>
  );
}
