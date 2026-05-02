import {
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabelledBy?: string;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  ariaLabelledBy = "dialog-title",
}: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && cardRef.current) {
        const focusables = cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const list = [...focusables].filter((el) => !el.hasAttribute("disabled"));
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener("keydown", handleKeyDown);
    const t = window.setTimeout(() => {
      const first = cardRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea',
      );
      first?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(t);
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="dialog-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-card__header">
          <span id={ariaLabelledBy}>{title}</span>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-card__body">{children}</div>
        {footer ? <div className="dialog-card__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
