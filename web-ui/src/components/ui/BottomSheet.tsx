import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalRoot } from "@/context/DemoEnv";
import "./ui.css";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the sheet. */
  label: string;
  children: ReactNode;
}

/** Touch action sheet (design `.sheet`): grab handle, top radius 12, backdrop tap and Esc close. */
export function BottomSheet({ open, onClose, label, children }: BottomSheetProps) {
  const root = usePortalRoot();
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restore.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="bottom-sheet__backdrop" data-testid="bottom-sheet-backdrop" onClick={() => onCloseRef.current()} />
      <div ref={ref} className="bottom-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="bottom-sheet__grab" aria-hidden="true" />
        {children}
      </div>
    </>,
    root,
  );
}
