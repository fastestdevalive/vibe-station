import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalRoot } from "@/context/DemoEnv";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import "./ui.css";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the sheet. */
  label: string;
  children: ReactNode;
}

/**
 * Height the on-screen keyboard covers (0 without one): a fixed sheet is not moved by iOS, so lift it by this.
 * `viewport` is the visual viewport's height, so the sheet can cap itself above the keyboard.
 */
function useKeyboardInset(active: boolean): { inset: number; viewport: number | null } {
  const [inset, setInset] = useState(0);
  const [viewport, setViewport] = useState<number | null>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return undefined;
    const update = () => {
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
      setViewport(Math.round(vv.height));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setInset(0);
      setViewport(null);
    };
  }, [active]);
  return { inset, viewport };
}

/**
 * Touch action sheet (design `.sheet`): grab handle, top radius 12, backdrop tap and Esc close. Tab is trapped
 * inside while open and the sheet sits above the on-screen keyboard (`visualViewport`).
 */
export function BottomSheet({ open, onClose, label, children }: BottomSheetProps) {
  const root = usePortalRoot();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { inset: keyboardInset, viewport } = useKeyboardInset(open);
  // Also hands focus back to whatever had it when the sheet opened (captured before the effect below focuses the sheet).
  useFocusTrap(ref, open);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // This listener is capture-phase, so it sees Escape before an open combobox (the editor's `/` or `@` menu)
        // can use it: that Escape closes the menu only; the next one closes the sheet.
        const t = e.target;
        if (t instanceof Element && ref.current?.contains(t) && t.closest('[role="combobox"][aria-expanded="true"]')) return;
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="bottom-sheet__backdrop" data-testid="bottom-sheet-backdrop" onClick={() => onCloseRef.current()} />
      <div
        ref={ref}
        className="bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={
          keyboardInset > 0 && viewport !== null
            ? { bottom: keyboardInset, maxHeight: `min(80vh, ${viewport - 16}px)` }
            : keyboardInset > 0
              ? { bottom: keyboardInset }
              : undefined
        }
      >
        <div className="bottom-sheet__grab" aria-hidden="true" />
        {children}
      </div>
    </>,
    root,
  );
}
